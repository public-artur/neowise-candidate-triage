import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const ready = { status: "ready", topic: "delivery", draft: "<b>Привезём завтра.</b>" };
const manual = { status: "manual_review", topic: null, draft: null };

function reply(body, status = 200) {
  return Response.json(body, { status });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function openPage() {
  const nodes = {};
  for (const [tag, id] of html.matchAll(/<[^<>]+\bid="([^"]+)"[^<>]*>/g)) {
    nodes[id] = { textContent: "", hidden: /\shidden\b/.test(tag) };
  }
  let onSubmit;
  const form = { addEventListener(type, listener) { if (type === "submit") onSubmit = listener; } };
  const requests = [];
  const document = { querySelector: (selector) => selector === "form" ? form : nodes[selector.slice(1)] };
  const fetch = (url, options) => {
    const request = deferred();
    requests.push({ ...request, url, options });
    return request.promise;
  };
  runInNewContext(script, { document, fetch });
  const submit = (text) => {
    nodes.message.value = text;
    return onSubmit({ preventDefault() {} });
  };
  return { nodes, requests, submit };
}

function assertCleared(nodes) {
  assert.equal(nodes.topic?.textContent, "");
  assert.equal(nodes.draft?.textContent, "");
  assert.equal(nodes.details?.hidden, true);
}

test("показывает тему и текст черновика, сохраняя заявку", async () => {
  const { nodes, requests, submit } = openPage();
  for (const [topic, name] of [["delivery", "Доставка"], ["pricing", "Стоимость"], ["other", "Другое"]]) {
    const pending = submit("Моя заявка");
    const request = requests.at(-1);
    assert.equal(request.url, "/api/triage");
    assert.equal(request.options.method, "POST");
    assert.deepEqual(JSON.parse(request.options.body), { text: "Моя заявка" });
    request.resolve(reply({ ...ready, topic }));
    await pending;
    assert.equal(nodes.topic?.textContent, name);
    assert.equal(nodes.draft?.textContent, ready.draft);
    assert.equal(nodes.details?.hidden, false);
    assert.equal(nodes.message.value, "Моя заявка");
  }
});

test("новый запрос сразу очищает результат, ручной разбор сохраняет исходный текст", async () => {
  const { nodes, requests, submit } = openPage();
  const first = submit("Первая");
  requests[0].resolve(reply(ready));
  await first;
  const next = submit("  Вторая  ");
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /разбираем/i);
  requests[1].resolve(reply(manual));
  await next;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /вручную/i);
  assert.equal(nodes.message.value, "  Вторая  ");
});

test("пустая заявка очищает результат, не создаёт запрос и отменяет показ прошлого ответа", async () => {
  const { nodes, requests, submit } = openPage();
  const first = submit("Первая");
  requests[0].resolve(reply(ready));
  await first;
  const blank = submit("  \n  ");
  assert.equal(requests.length, 1);
  await blank;
  assertCleared(nodes);
  const late = submit("Поздний ответ");
  await submit("");
  requests[1].resolve(reply(ready));
  await late;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /введите/i);
  assert.equal(requests.length, 2);
});

test("ошибка сети не возвращает старый черновик", async () => {
  const { nodes, requests, submit } = openPage();
  const first = submit("Первая");
  requests[0].resolve(reply(ready));
  await first;
  const next = submit("Вторая");
  requests[1].reject(new Error("offline"));
  await next;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /повторите/i);
  assert.equal(nodes.message.value, "Вторая");
});

test("проверяет HTTP-статус, статус API и поля ответа", async () => {
  const { nodes, requests, submit } = openPage();
  for (const response of [
    reply(ready, 500), reply(ready, 201), reply({ status: "unknown" }), reply(null),
    reply({ ...ready, topic: "__proto__" }), reply({ ...ready, draft: "  " }),
    reply({ ...ready, draft: 3 }), reply(manual, 503), reply({ ...manual, draft: "лишний" }),
    reply({ status: "invalid_input" }, 200), new Response("broken JSON"),
  ]) {
    const pending = submit("Исходный текст");
    requests.at(-1).resolve(response);
    await pending;
    assertCleared(nodes);
    assert.match(nodes.result.textContent, /повторите/i);
  }
  const invalid = submit("Проверить ввод");
  requests.at(-1).resolve(reply({ status: "invalid_input" }, 400));
  await invalid;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /проверьте текст/i);
});

test("поздний ответ или ошибка старого запроса не затирают актуальный результат", async () => {
  for (const outcome of ["response", "error", "delayed JSON"]) {
    const { nodes, requests, submit } = openPage();
    const first = submit("Первая");
    const parsed = deferred();
    if (outcome === "delayed JSON") {
      const started = deferred();
      requests[0].resolve({ status: 200, json() { started.resolve(); return parsed.promise; } });
      await started.promise;
    }
    const next = submit("Вторая");
    requests[1].resolve(reply(ready));
    await next;
    const status = nodes.result.textContent;
    if (outcome === "response") requests[0].resolve(reply(manual));
    if (outcome === "error") requests[0].reject(new Error("late error"));
    if (outcome === "delayed JSON") parsed.resolve(manual);
    await first;
    assert.equal(nodes.result.textContent, status, outcome);
    assert.equal(nodes.draft?.textContent, ready.draft, outcome);
    assert.equal(nodes.message.value, "Вторая");
  }
});

test("поздний ready не возвращает черновик после ручного разбора новой заявки", async () => {
  const { nodes, requests, submit } = openPage();
  const first = submit("Первая");
  const next = submit("Вторая");
  requests[1].resolve(reply(manual));
  await next;
  requests[0].resolve(reply(ready));
  await first;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /вручную/i);
  assert.equal(nodes.message.value, "Вторая");
});

test("поздняя ошибка оставляет новую заявку в обработке", async () => {
  const { nodes, requests, submit } = openPage();
  const first = submit("Первая");
  const next = submit("Вторая");
  requests[0].reject(new Error("late error"));
  await first;
  assertCleared(nodes);
  assert.match(nodes.result.textContent, /разбираем/i);
  requests[1].resolve(reply(ready));
  await next;
  assert.equal(nodes.draft.textContent, ready.draft);
});
