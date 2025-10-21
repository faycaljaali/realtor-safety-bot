import { expireTimersNow } from "./whatsapp.js";

export default async function handler(req, res) {
  await expireTimersNow();
  res.status(200).end("ok");
}
