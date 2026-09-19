'use strict';

// ============================================================================================
// LOCAL SHIM — node-domexception
// ============================================================================================
// Package `node-domexception` 1.0.0 đã bị author deprecate với khuyến nghị: "Use your platform's
// native DOMException instead". Node 18+ (engines của project: >=22.11.0) đã có native
// `globalThis.DOMException`, nên transitive dep (ví dụ fetch-blob/formdata-node/node-fetch) vẫn
// import package này chỉ để fallback trên Node cũ. Ta redirect qua `overrides` (package.json) để
// npm resolve `node-domexception` về shim này → xoá deprecation warning mà không thay đổi behavior:
// shim re-export chính xác cuộc đời của native DOMException.
//
// Contract của package gốc:
//   const DOMException = require('node-domexception');
//   throw new DOMException('msg', 'AbortError');
// Nên shim phải xuất class DOMException làm default export (CommonJS module.exports = Class),
// với constructor signature (message, name) tương thích WHATWG spec.
// ============================================================================================

const Native = typeof globalThis !== 'undefined' && globalThis.DOMException;

if (Native) {
  module.exports = Native;
} else {
  // Fallback cực hiếm (Node < 17 không expose global). Giữ API tương thích với native.
  class DOMExceptionShim extends Error {
    constructor(message, name) {
      super(message);
      this.name = name || 'Error';
      this.code = DOMExceptionShim[this.name] || 0;
    }
  }
  // Legacy code numbers per WHATWG DOM spec.
  const codes = {
    IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
    NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
    InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
    InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19,
    AbortError: 20, URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23,
    InvalidNodeTypeError: 24, DataCloneError: 25
  };
  for (const [name, code] of Object.entries(codes)) {
    Object.defineProperty(DOMExceptionShim, name, { value: code, enumerable: true });
    Object.defineProperty(DOMExceptionShim.prototype, name, { value: code, enumerable: false });
  }
  module.exports = DOMExceptionShim;
}
