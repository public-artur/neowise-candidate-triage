import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createTriageServer } from "../server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };

async function startApi(t, classifier) {
  const server = createTriageServer(classifier);
  await once(server.listen(0, "127.0.0.1"), "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/triage`;
  return async function check(body, status, expected) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), expected);
  };
}

for (const [text, topic] of [
  ["Когда доставка?", "delivery"],
  ["Какая цена?", "pricing"],
  ["Добрый день!", "other"],
]) {
  test(`ordinary request produces a ready ${topic} draft`, async (t) => {
    const check = await startApi(t);
    await check(JSON.stringify({ text }), 200, {
      status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });
}

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`${marker} produces manual review`, async (t) => {
    const check = await startApi(t);
    await check(JSON.stringify({ text: marker }), 200, manualReview);
  });
}

test("invalid input returns 400 before calling the model", async (t) => {
  const classify = t.mock.fn();
  const check = await startApi(t, classify);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  for (const body of [
    "", "{", "null", "[]", "42", '"delivery"', "{}", '{"text":null}',
    '{"text":42}', '{"text":[]}', '{"text":""}', '{"text":"  \\n\\t"}', invalidUtf8,
  ]) {
    await check(body, 400, { status: "invalid_input" });
  }
  assert.equal(classify.mock.callCount(), 0);
});

test("the model must return a valid topic and draft and cannot add response fields", async (t) => {
  const check = await startApi(t, (text) => text);
  for (const text of [
    "null", "[]", "42", "{}", '{"topic":"delivery"}', '{"topic":"delivery","draft":23}', '{"draft":"OK"}',
  ]) {
    await check(JSON.stringify({ text }), 200, manualReview);
  }
  const text = JSON.stringify({ topic: "pricing", draft: "OK", status: "wrong", extra: true });
  await check(JSON.stringify({ text }), 200, { status: "ready", topic: "pricing", draft: "OK" });
});

test("the 300 ms deadline aborts the model and finishes even if it ignores cancellation",
  { timeout: 5000 }, async (t) => {
    const schedule = t.mock.method(globalThis, "setTimeout");
    let signal;
    const check = await startApi(t, (_text, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    await check('{"text":"test"}', 200, manualReview);
    assert.ok(signal.aborted);
    assert.ok(schedule.mock.calls.some((call) => call.arguments[1] === 300));
  });

test("finishing early clears the deadline timer", async (t) => {
  const schedule = t.mock.method(globalThis, "setTimeout");
  const cancel = t.mock.method(globalThis, "clearTimeout");
  const check = await startApi(t);
  await check('{"text":"[error]"}', 200, manualReview);
  const deadline = schedule.mock.calls.find((call) => call.arguments[1] === 300);
  assert.ok(deadline);
  assert.ok(cancel.mock.calls.some((call) => call.arguments[0] === deadline.result));
});
