/**
 * CSS 模块类型声明
 *
 * 允许在 TypeScript 中以 import 方式引入 .css 文件，
 * 默认导出为 CSS 文件的字符串内容。
 */
declare module '*.css' {
  const content: string;
  export default content;
}
