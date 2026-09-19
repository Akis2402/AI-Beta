'use strict';

/* =====================================================================================
   exprEval.js — PHẦN C (P0): TRÌNH PHÂN TÍCH/TÍNH BIỂU THỨC TOÁN AN TOÀN DƯỚI CSP
   -------------------------------------------------------------------------------------
   ROOT CAUSE của lỗi "mặt cong z=f(x,y) không bao giờ hiện trên production":
   scene3d.js dùng `new Function('x','y','Math', 'with(Math){ return (...) }')`. CSP của app
   KHÔNG có 'unsafe-eval' (và không được thêm), nên trình duyệt CHẶN ngay lệnh đó. Toàn bộ khối
   được bọc trong try/catch nên lỗi bị nuốt và hàm trả null — hình biến mất KHÔNG có thông báo,
   chỉ có 1 dòng CSP violation trong console. Dùng regex whitelist ký tự cũng không cứu được:
   vấn đề không phải nội dung biểu thức mà là CƠ CHẾ biên dịch.

   FIX: tự phân tích cú pháp (recursive descent) rồi dựng CÂY BIỂU THỨC bằng closure thuần.
   Không eval, không new Function, không Function constructor, không truy cập thuộc tính,
   không window/document/fetch, không đụng prototype. Ngữ pháp hỗ trợ ĐÚNG những gì spec 3D cần:

     expr    := term (('+'|'-') term)*
     term    := unary (('*'|'/'|'%') unary)*
     unary   := ('+'|'-') unary | power
     power   := atom ('^' unary)?          // ^ kết hợp phải: 2^3^2 = 2^(3^2)
     atom    := number | const | var | func '(' args ')' | '(' expr ')'

   Hàm/hằng số nằm trong DANH SÁCH TRẮNG CỐ ĐỊNH bên dưới — tên lạ là lỗi cú pháp, không phải
   "tra cứu trên object nào đó".
   ===================================================================================== */

(function (global) {
  var MAX_EXPR_LEN = 500;   // biểu thức dài bất thường -> từ chối (chống biểu thức khổng lồ làm treo tab)
  var MAX_NODES = 400;      // trần số nút của cây (chống lồng sâu/bùng nổ)

  var CONSTANTS = { pi: Math.PI, e: Math.E, PI: Math.PI, E: Math.E };

  var FUNCTIONS = {
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
    asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
    sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
    sqrt: [1, Math.sqrt], abs: [1, Math.abs], exp: [1, Math.exp],
    log: [1, Math.log], ln: [1, Math.log], log10: [1, Math.log10], log2: [1, Math.log2],
    floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], sign: [1, Math.sign],
    atan2: [2, Math.atan2], pow: [2, Math.pow], min: [2, Math.min], max: [2, Math.max],
    hypot: [2, Math.hypot]
  };

  function tokenize(src) {
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        var start = i;
        while (i < src.length && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) i++;
        // KHÔNG hỗ trợ ký hiệu mũ kiểu 1e5: 'e' là hằng số Euler trong ngữ pháp này, nhập nhằng
        // là nguồn lỗi im lặng. Muốn 1e5 thì viết 100000 hoặc 1*10^5.
        var num = Number(src.slice(start, i));
        if (!isFinite(num)) return null;
        tokens.push({ t: 'num', v: num });
        continue;
      }
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
        var s2 = i;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
        tokens.push({ t: 'name', v: src.slice(s2, i) });
        continue;
      }
      if ('+-*/%^(),'.indexOf(c) >= 0) { tokens.push({ t: c }); i++; continue; }
      return null; // ký tự không thuộc ngữ pháp -> từ chối thẳng, không "bỏ qua cho lành"
    }
    return tokens;
  }

  /**
   * compile() — biên dịch biểu thức thành hàm (vars) => number.
   * @param {string} source
   * @param {string[]} [varNames] tên biến được phép (mặc định ['x','y'])
   * @returns {{ok:boolean, fn?:function, reason?:string}}
   */
  function compile(source, varNames) {
    var vars = varNames || ['x', 'y'];
    var src = String(source == null ? '' : source);
    if (!src.trim()) return { ok: false, reason: 'empty_expression' };
    if (src.length > MAX_EXPR_LEN) return { ok: false, reason: 'expression_too_long' };

    var tokens = tokenize(src);
    if (!tokens || !tokens.length) return { ok: false, reason: 'invalid_characters' };

    var pos = 0;
    var nodeCount = 0;
    var failed = null;

    function fail(reason) { if (!failed) failed = reason; return function () { return NaN; }; }
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function expect(type) {
      var tk = tokens[pos];
      if (!tk || tk.t !== type) { fail('expected_' + type); return false; }
      pos++;
      return true;
    }
    function node(fn) {
      nodeCount++;
      if (nodeCount > MAX_NODES) fail('expression_too_complex');
      return fn;
    }

    function parseExpr() {
      var left = parseTerm();
      while (!failed && peek() && (peek().t === '+' || peek().t === '-')) {
        var op = next().t;
        var right = parseTerm();
        left = (function (l, r, o) {
          return node(o === '+'
            ? function (env) { return l(env) + r(env); }
            : function (env) { return l(env) - r(env); });
        })(left, right, op);
      }
      return left;
    }

    function parseTerm() {
      var left = parseUnary();
      while (!failed && peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
        var op = next().t;
        var right = parseUnary();
        left = (function (l, r, o) {
          if (o === '*') return node(function (env) { return l(env) * r(env); });
          if (o === '/') return node(function (env) { return l(env) / r(env); }); // chia 0 -> Infinity, caller tự lọc
          return node(function (env) { return l(env) % r(env); });
        })(left, right, op);
      }
      return left;
    }

    function parseUnary() {
      var tk = peek();
      if (tk && (tk.t === '+' || tk.t === '-')) {
        next();
        var operand = parseUnary();
        if (tk.t === '-') return node(function (env) { return -operand(env); });
        return operand;
      }
      return parsePower();
    }

    function parsePower() {
      var base = parseAtom();
      if (!failed && peek() && peek().t === '^') {
        next();
        var exp = parseUnary(); // kết hợp phải
        return node(function (env) { return Math.pow(base(env), exp(env)); });
      }
      return base;
    }

    function parseAtom() {
      var tk = next();
      if (!tk) return fail('unexpected_end');
      if (tk.t === 'num') { var v = tk.v; return node(function () { return v; }); }
      if (tk.t === '(') {
        var inner = parseExpr();
        if (!expect(')')) return fail('unbalanced_parentheses');
        return inner;
      }
      if (tk.t === 'name') {
        var name = tk.v;
        if (peek() && peek().t === '(') {
          var spec = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : null;
          if (!spec) return fail('unknown_function');
          next(); // '('
          var args = [];
          if (peek() && peek().t !== ')') {
            args.push(parseExpr());
            while (!failed && peek() && peek().t === ',') { next(); args.push(parseExpr()); }
          }
          if (!expect(')')) return fail('unbalanced_parentheses');
          if (args.length !== spec[0]) return fail('wrong_argument_count');
          var impl = spec[1];
          if (spec[0] === 1) {
            var a0 = args[0];
            return node(function (env) { return impl(a0(env)); });
          }
          var b0 = args[0], b1 = args[1];
          return node(function (env) { return impl(b0(env), b1(env)); });
        }
        if (vars.indexOf(name) >= 0) {
          return node(function (env) { var val = env[name]; return typeof val === 'number' ? val : NaN; });
        }
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
          var cv = CONSTANTS[name];
          return node(function () { return cv; });
        }
        // Tên không phải biến/hằng/hàm trong danh sách trắng: KHÔNG tra cứu ở bất kỳ đâu khác.
        return fail('unknown_identifier');
      }
      return fail('unexpected_token');
    }

    var tree = parseExpr();
    if (failed) return { ok: false, reason: failed };
    if (pos !== tokens.length) return { ok: false, reason: 'trailing_tokens' };

    return {
      ok: true,
      fn: function (env) {
        var out = tree(env || {});
        return typeof out === 'number' ? out : NaN;
      }
    };
  }

  /** Tiện ích cho scene3d: trả hàm (x,y)=>z, hoặc null nếu biểu thức không hợp lệ. */
  function compileXY(source) {
    var res = compile(source, ['x', 'y']);
    if (!res.ok) return null;
    return function (x, y) { return res.fn({ x: x, y: y }); };
  }

  var api = { compile: compile, compileXY: compileXY, FUNCTIONS: FUNCTIONS, CONSTANTS: CONSTANTS, MAX_EXPR_LEN: MAX_EXPR_LEN };
  global.ExprEval = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
