import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { createRequire } from 'node:module';

// ============================================================================================
// V5.2 fix — tắt Turbopack static analysis của `server/app.js`
// ============================================================================================
// Trước đây dùng `require('../../server/app')` — Turbopack thấy CommonJS require với đường dẫn
// tĩnh nên trảng hải toàn bộ cây import của server/app.js vào graph, rồi báo TP1103 vì pattern
// `const app = express(); app.set(...)` không thể truy vết tĩnh (helmet/compression/express
// có side-effect setter không thể tĩnh hóa). Dùng `createRequire` từ node:module để tạo một
// Node CommonJS require ở runtime: Turbopack coi call này là opaque (không biết URL nào sẽ
// được tải), bỏ qua static analysis → không còn warning. Runtime vẫn resolve bình thường vì
// Node ESM hỗ trợ createRequire chuẩn từ v14.
// ============================================================================================

const nodeRequire = createRequire(import.meta.url);
let cachedApp: any = null;

function getExpressApp() {
  if (!cachedApp) {
    cachedApp = nodeRequire('../../server/app');
  }
  return cachedApp;
}

export async function handleNextApiRequest(req: NextRequest | Request): Promise<Response> {
  const app = getExpressApp();
  const url = new URL(req.url);

  // Read body buffer if present to provide accurate content-length for body-parser
  let bodyBuffer: Buffer | null = null;
  if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      const arrayBuffer = await req.arrayBuffer();
      bodyBuffer = Buffer.from(arrayBuffer);
    } catch {
      bodyBuffer = Buffer.alloc(0);
    }
  }

  const nodeReq: any = bodyBuffer ? Readable.from([bodyBuffer]) : Readable.from([]);
  nodeReq.method = req.method;
  nodeReq.url = url.pathname + url.search;
  nodeReq.headers = {};
  for (const [k, v] of req.headers.entries()) {
    nodeReq.headers[k.toLowerCase()] = v;
  }
  if (bodyBuffer) {
    nodeReq.headers['content-length'] = String(bodyBuffer.length);
  }

  nodeReq.socket = {
    remoteAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
    encrypted: true,
    destroy() {}
  };
  nodeReq.connection = nodeReq.socket;
  nodeReq.httpVersion = '1.1';
  nodeReq.httpVersionMajor = 1;
  nodeReq.httpVersionMinor = 1;

  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const responseHeaders = new Headers();
    let isStreaming = false;

    const webStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        streamController = ctrl;
      },
      cancel() {
        nodeReq.emit('close');
        nodeReq.emit('aborted');
        nodeRes.emit('close');
      }
    });

    const nodeRes: any = new EventEmitter();
    nodeRes.statusCode = 200;
    nodeRes.headersSent = false;

    nodeRes.setHeader = (name: string, val: any) => {
      const key = name.toLowerCase();
      const valStr = Array.isArray(val) ? val.join(', ') : String(val);
      responseHeaders.set(key, valStr);
      if (key === 'content-type' && valStr.includes('text/event-stream')) {
        isStreaming = true;
      }
    };
    nodeRes.getHeader = (name: string) => responseHeaders.get(name.toLowerCase());
    nodeRes.hasHeader = (name: string) => responseHeaders.has(name.toLowerCase());
    nodeRes.removeHeader = (name: string) => responseHeaders.delete(name.toLowerCase());
    nodeRes.getHeaders = () => Object.fromEntries(responseHeaders.entries());

    function commitHeaders() {
      if (!resolved) {
        resolved = true;
        nodeRes.headersSent = true;
        resolve(
          new Response(webStream, {
            status: nodeRes.statusCode || 200,
            headers: responseHeaders
          })
        );
      }
    }

    nodeRes.writeHead = (status: number, maybeMsg?: any, maybeHdrs?: any) => {
      nodeRes.statusCode = status;
      if (typeof maybeMsg === 'object' && maybeMsg !== null) {
        for (const [k, v] of Object.entries(maybeMsg)) {
          nodeRes.setHeader(k, v);
        }
      } else if (typeof maybeHdrs === 'object' && maybeHdrs !== null) {
        for (const [k, v] of Object.entries(maybeHdrs)) {
          nodeRes.setHeader(k, v);
        }
      }
      commitHeaders();
      return nodeRes;
    };

    nodeRes.write = (chunk: any, enc?: any, cb?: any) => {
      commitHeaders();
      if (chunk && streamController) {
        const u8 = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
        try {
          streamController.enqueue(new Uint8Array(u8));
        } catch {
          // Stream might be closed by client
        }
      }
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };

    nodeRes.end = (chunk?: any, enc?: any, cb?: any) => {
      commitHeaders();
      if (chunk && streamController) {
        const u8 = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
        try {
          streamController.enqueue(new Uint8Array(u8));
        } catch {
          // Stream might be closed
        }
      }
      if (streamController) {
        try {
          streamController.close();
        } catch {}
      }
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      nodeRes.emit('finish');
      return nodeRes;
    };

    nodeRes.flush = () => {};
    nodeRes.flushHeaders = () => commitHeaders();

    if (req.signal) {
      req.signal.addEventListener('abort', () => {
        nodeReq.emit('close');
        nodeReq.emit('aborted');
        nodeRes.emit('close');
      });
    }

    try {
      app(nodeReq, nodeRes);
    } catch (err) {
      if (!resolved) {
        reject(err);
      }
    }
  });
}
