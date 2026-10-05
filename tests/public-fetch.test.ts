import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchPublicText, isPublicIp, parsePublicWebUrl } from "../server/web/public-fetch.js";

test("public page reader rejects local, private, credentialed and nonstandard destinations", async () => {
  for (const url of [
    "http://127.0.0.1:8787/api/memories",
    "http://2130706433/api/memories",
    "http://localhost/api/memories",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/api/memories",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "file:///etc/passwd"
  ]) {
    assert.throws(() => parsePublicWebUrl(url));
  }
  assert.equal(parsePublicWebUrl("https://example.com/docs").hostname, "example.com");
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  for (const address of ["10.0.0.1", "100.64.0.1", "172.16.0.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicIp(address), false, address);
  }
});

test("public page reader blocks a local HTTP service before connecting", async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("private content"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(fetchPublicText(`http://127.0.0.1:${address.port}/api/memories`), /标准 HTTP\/HTTPS 端口|本机或内网/);
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
