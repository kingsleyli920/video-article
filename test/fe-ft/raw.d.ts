// Vite 的 ?raw 导入：拿到文件原文。L1d 用它把真实的 index.html 放进 jsdom。
declare module '*.html?raw' {
  const content: string;
  export default content;
}
