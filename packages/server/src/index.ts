import { buildServer } from "./http/app";
import { MessageRouter } from "./ws/messageRouter";

export interface StartOptions {
  port?: number;
  host?: string;
}

export async function start(opts: StartOptions = {}): Promise<{ close: () => Promise<void>; url: string }> {
  const router = new MessageRouter({ byConnection: () => null });
  const app = await buildServer({ router });

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? "0.0.0.0";
  await app.listen({ port, host });

  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `ws://127.0.0.1:${actualPort}/ws`,
    close: () => app.close(),
  };
}

const isMain = Boolean(process.argv[1]) && /index\.(ts|js)$/.test(process.argv[1]!);
if (isMain) {
  start()
    .then((s) => console.log(`server listening at ${s.url}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
