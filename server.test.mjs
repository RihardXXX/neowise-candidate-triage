import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const servers = [];

async function startApp(options) {
  const logs = [];
  const server = createApp({ log: (line) => logs.push(line), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const post = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  return { post, logs };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

const app = await startApp();

test("корректная заявка: ready с темой и черновиком", async () => {
  const reply = await app.post(JSON.stringify({ text: "Когда будет доставка?" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

for (const [label, reason] of [
  ["[timeout]", "timeout"],
  ["[error]", "model_error"],
  ["[bad-json]", "bad_output"],
  ["[bad-topic]", "bad_output"],
  ["[empty-draft]", "bad_output"],
]) {
  test(`сбой модели ${label}: manual_review, причина ${reason}`, async () => {
    const reply = await app.post(JSON.stringify({ text: `Заявка ${label}` }));
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    assert.equal(app.logs.at(-1), `[triage] manual_review reason=${reason}`);
  });
}

test("таймаут: ждём модель не дольше 300 мс (имитатор отвечает через 1200 мс)", async () => {
  const started = performance.now();
  const reply = await app.post(JSON.stringify({ text: "Заявка [timeout]" }));
  const elapsed = performance.now() - started;
  assert.deepEqual(await reply.json(), MANUAL_REVIEW);
  assert.ok(elapsed >= 250, `ответ раньше таймаута: ${elapsed} мс`);
  assert.ok(elapsed < 1000, `ожидание не ограничено: ${elapsed} мс`);
});

test("таймаут срабатывает, даже если модель не слушает signal", async () => {
  const deaf = await startApp({
    classify: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(JSON.stringify({ topic: "other", draft: "поздно" })), 2_000).unref();
      }),
  });
  const started = performance.now();
  const reply = await deaf.post(JSON.stringify({ text: "Любая заявка" }));
  assert.deepEqual(await reply.json(), MANUAL_REVIEW);
  assert.ok(performance.now() - started < 1000);
  assert.equal(deaf.logs.at(-1), "[triage] manual_review reason=timeout");
});

test("некорректный ввод: 400 invalid_input, модель не вызывается", async () => {
  const calls = [];
  const spy = await startApp({
    classify: async (text) => {
      calls.push(text);
      return JSON.stringify({ topic: "other", draft: "ответ" });
    },
  });
  for (const body of ["{}", '{"text":""}', '{"text":"   "}', '{"text":42}', '{"text":null}', "null", "[]", "не JSON", ""]) {
    const reply = await spy.post(body);
    assert.equal(reply.status, 400, `тело ${JSON.stringify(body)}`);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  }
  assert.deepEqual(calls, []);
});
