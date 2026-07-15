import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { promoteAtom, sealAtom } from '../core/ingest.js';
import { buildState, effectiveRow, headSeq, movePreview, tierMove, viewerReport, type UiDeps } from './api.js';
import { renderPage } from './page.js';

/**
 * The owner UI server. Threat model: whoever can call the write API can
 * sign any authorization, so the server is locked to loopback and every
 * /api request must carry the session token printed at startup (delivered
 * to the page via the URL fragment, which never leaves the browser).
 *
 * Every write handler is a one-line pass-through to an existing core
 * function — the UI invents no capability the CLI and console don't have.
 */

const grantSchema = z.object({
  object: z.string().min(1),
  relation: z.string().min(1),
  subject: z.string().min(1),
  resolution: z.number().int(),
});
const revokeSchema = z.object({
  object: z.string().min(1),
  relation: z.string().min(1),
  subject: z.string().min(1),
});
const tierMoveSchema = z.object({
  person: z.string().min(1),
  from: z.string().min(1).nullable(),
  to: z.string().min(1),
});
const atomSchema = z.object({ atomId: z.string().min(1) });

const MAX_BODY = 1_000_000;

export function createUiServer(deps: UiDeps, opts?: { token?: string }): { server: Server; token: string } {
  const token = opts?.token ?? randomBytes(16).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const authorized = (req: IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const hostAllowed = (req: IncomingMessage): boolean => {
    const port = req.socket.localPort;
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding defense: a hostile page resolving its own domain to
    // 127.0.0.1 still sends its domain in Host.
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' });

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage());
      return;
    }

    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // No Access-Control-Allow-* is ever sent: cross-origin pages can
    // neither preflight a write nor read any response.
    if (!authorized(req)) return json(res, 401, { error: 'missing or bad token' });

    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/api/head':
          return json(res, 200, { seq: headSeq(deps.db) });
        case '/api/state':
          return json(res, 200, buildState(deps));
        case '/api/viewer': {
          const person = url.searchParams.get('person');
          if (!person) return json(res, 400, { error: 'person query param required' });
          return json(res, 200, viewerReport(deps, person));
        }
        case '/api/effective': {
          const person = url.searchParams.get('person');
          if (!person) return json(res, 400, { error: 'person query param required' });
          return json(res, 200, effectiveRow(deps, person));
        }
        case '/api/move-preview': {
          const person = url.searchParams.get('person');
          const to = url.searchParams.get('to');
          if (!person || !to) return json(res, 400, { error: 'person and to query params required' });
          return json(res, 200, movePreview(deps, person, url.searchParams.get('from'), to));
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(res, 415, { error: 'content-type must be application/json' });
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }

    try {
      switch (url.pathname) {
        case '/api/grant': {
          deps.acl.grant(grantSchema.parse(body));
          break;
        }
        case '/api/revoke': {
          deps.acl.revoke(revokeSchema.parse(body));
          break;
        }
        case '/api/tier-move': {
          const move = tierMoveSchema.parse(body);
          tierMove(deps.acl, move.person, move.from, move.to);
          break;
        }
        case '/api/promote': {
          promoteAtom(deps, atomSchema.parse(body).atomId, deps.ownerId);
          break;
        }
        case '/api/seal': {
          sealAtom(deps, atomSchema.parse(body).atomId, deps.ownerId);
          break;
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : err instanceof Error
            ? err.message
            : String(err);
      return json(res, 400, { error: message });
    }

    return json(res, 200, { ok: true, headSeq: headSeq(deps.db) });
  }

  return { server, token };
}
