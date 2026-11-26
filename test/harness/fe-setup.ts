/**
 * 前端测试的环境补丁。Node 22 起自带一个全局的 localStorage（没有配置存储文件时不可用），
 * 它挡住了 jsdom 提供的那个。这里把 jsdom 窗口的 localStorage 放回全局，测试里的本地存储才和浏览器里一样可用。
 */
declare global {
  // vitest 的 jsdom 环境把 JSDOM 实例放在这里
  var jsdom: { window: { localStorage: Storage } } | undefined;
}

if (globalThis.jsdom) {
  Object.defineProperty(globalThis, 'localStorage', { value: globalThis.jsdom.window.localStorage, configurable: true });
}

export {};
