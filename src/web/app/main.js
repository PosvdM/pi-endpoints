// @ts-check
// 管理页的入口：token 由服务端写进页面的 <meta>，之后的接口请求放在请求头里。
import { startApp } from "./app.js";

const token = document.querySelector('meta[name="endpoints-token"]')?.getAttribute("content") ?? "";
const root = document.getElementById("root");
if (root) startApp(root, { token, search: location.search });
