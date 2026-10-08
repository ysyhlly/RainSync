import { createServer } from "node:net";

// The listener is closed before returning; this does not reserve the port.
export async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) =>
    listener.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
