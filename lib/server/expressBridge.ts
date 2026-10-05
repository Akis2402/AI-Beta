import { NextRequest, after } from 'next/server';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { createRequire } from 'node:module';

// ============================================================================================
// V5.2 — ghi chú về `createRequire` (ĐÃ SỬA NỘI DUNG SAI: bản cũ nói nó "tắt Turbopack static analysis")
// ============================================================================================
// Đo thực tế (Next 16.3.8, dự án tối thiểu cùng mẫu `createRequire(import.meta.url)` + `nodeRequire('../server/app')`):
// Turbopack VẪN nhận ra đây là require tĩnh, vẫn đưa server/app.js vào graph và vẫn phân tích nó. Cảnh báo
// TP1103 chỉ biến mất khi server/app.js KHÔNG viết `app.set('trust proxy', <literal>)` (xem server/app.js).
// Đừng "sửa" bằng `/* turbopackIgnore: true */` tại require này: đã thử, cảnh báo mất nhưng file tracing KHÔNG còn
// đưa express/compression/server/** vào bundle -> production sẽ "Cannot find module" khi deploy Vercel.
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

  // Việc nền phải hoàn tất sau khi response đã gửi (vd. ghi token thật vào quota). Trên Vercel, function có thể bị
  // freeze ngay khi response kết thúc => phải đăng ký với after() của Next để platform giữ function sống.
  // after() phải được gọi TRONG phạm vi request => gọi ngay ở đây, callback đọc danh sách lúc chạy.
  const bgTasks: Promise<unknown>[] = [];
  nodeReq.waitUntil = (p: Promise<unknown>) => { bgTasks.push(Promise.resolve(p).catch(() => undefined)); };
  try {
    after(async () => {
      let seen = -1;
      while (seen !== bgTasks.length) { // việc mới có thể được thêm trong lúc đang chờ
        seen = bgTasks.length;
        await Promise.all(bgTasks.slice());
      }
    });
  } catch {
    // Ngoài phạm vi request của Next (script/test): không có after() — chạy bình thường, không chặn request.
  }

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

    // Set-Cookie PHẢI là danh sách riêng: Headers.set() + join(', ') sẽ gộp nhiều cookie thành 1 chuỗi
    // mà trình duyệt không tách được (Expires chứa dấu phẩy) -> phiên đăng nhập không được lưu. Dùng append() lúc commit.
    const setCookies: string[] = [];

    nodeRes.setHeader = (name: string, val: any) => {
      const key = name.toLowerCase();
      if (key === 'set-cookie') {
        setCookies.length = 0;
        (Array.isArray(val) ? val : [val]).forEach((v: any) => setCookies.push(String(v)));
        return;
      }
      const valStr = Array.isArray(val) ? val.join(', ') : String(val);
      responseHeaders.set(key, valStr);
      if (key === 'content-type' && valStr.includes('text/event-stream')) {
        isStreaming = true;
      }
    };
    nodeRes.getHeader = (name: string) => {
      const key = name.toLowerCase();
      if (key === 'set-cookie') return setCookies.length ? [...setCookies] : undefined;
      return responseHeaders.get(key);
    };
    nodeRes.hasHeader = (name: string) => {
      const key = name.toLowerCase();
      return key === 'set-cookie' ? setCookies.length > 0 : responseHeaders.has(key);
    };
    nodeRes.removeHeader = (name: string) => {
      const key = name.toLowerCase();
      if (key === 'set-cookie') { setCookies.length = 0; return; }
      responseHeaders.delete(key);
    };
    nodeRes.getHeaders = () => {
      const h: Record<string, any> = Object.fromEntries(responseHeaders.entries());
      if (setCookies.length) h['set-cookie'] = [...setCookies];
      return h;
    };

    function commitHeaders() {
      if (!resolved) {
        resolved = true;
        nodeRes.headersSent = true;
        setCookies.forEach((c) => responseHeaders.append('set-cookie', c));
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
