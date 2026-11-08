# Proofreading service

Page-image proofread is **optional and off by default**. Komatose itself ships no
proofreading backend. Instead it can talk to a separate
service that you run and configure yourself.

## Turning it on

Set two variables in `.env`:

```bash
SCAN_PROOFREAD_SERVICE_URL=http://127.0.0.1:9231
SCAN_PROOFREAD_SERVICE_TOKEN=choose-a-long-random-value
```

While `SCAN_PROOFREAD_SERVICE_URL` is unset:

- no proofreader rows are listed at all, in any picker or toolbar;
- saved settings that name a proofreader resolve to a disabled row with a reason,
  rather than silently running something else.

Once it is set, Komatose asks the service which proofreaders it has and offers
those. Readiness comes from that report, including a proofreader that is not
ready yet, so it can be started. A saved registry row the service did not report
stays listed as unavailable. Komatose does not invent proofreaders the service
left out.

## The contract

The service is addressed over loopback with a bearer token
(`SCAN_PROOFREAD_SERVICE_TOKEN`). Everything is deliberately neutral: Komatose
sends a `mode`, images, and text, and receives critique text plus an opaque
conversation token. It never learns how the reply is produced. Page proofread,
including a follow-up on the same page, sends `mode: "critique"`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness only. |
| `GET` | `/v1/proofreaders` | The proofreader catalog, and readiness for each one. |
| `POST` | `/v1/proofreaders/start` | Bring one proofreader up. |
| `POST` | `/v1/proofread` | Send `mode`, images, and an optional prompt. Return `{ critique, context }`. |

`GET /v1/proofreaders` returns `{ proofreaders: [ ... ] }`. Each item is
`{ id, ready, context, reason }` and may also include `label` or `name`. That
list is the catalog: Komatose offers the ids the service reports and does not
hardcode a pair of its own. When an item has no `label` or `name`, the id is
shown in title case (`proofreader-a` is shown as "Proofreader A"). An id
Komatose has not seen before is kept. Ids that are not slugs, or that belong to
a built-in engine, are ignored. What implements an id is the service's
business.

The Translate **Proofread Raw** action sends one raw page image with `mode: raw`.
The existing raw and typeset comparison sends `mode: critique`; its follow-ups
also use `mode: critique`.

`context` is an opaque token. Komatose stores it and sends it back to decide
whether a follow-up continues the same conversation or starts a new one. It must
not be parsed or displayed.

## Implementing your own

Any process that speaks the contract above will work, as long as it:

1. accepts raw image first and typeset image second, in that order;
2. returns critique text and an opaque `context`;
3. reports honest readiness, so tools stay hidden when it is not usable.

If you implement one with a different backend — an API, a local model, anything
else — Komatose needs no changes. That is the point of the split: the service is
the only part that knows how a proofreader produces its reply, and it is not part
of this repository.

## Access

Proofreading is not exposed to every user by default. It is granted per user from
**Admin → Users**, and the toolbar entry is hidden for anyone without the grant.
