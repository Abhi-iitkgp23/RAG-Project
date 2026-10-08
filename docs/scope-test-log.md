# Scope classifier check

Phase 6 live check from [implementationPlan.md](./implementationPlan.md). `scripts/scopeCheck.ts` calls the scope classifier directly. It does not write a conversation.

| Question | Decision |
| --- | --- |
| How many calories should I eat to lose weight? | No decision. Groq returned HTTP 401 Invalid API Key before a classification. |
| How long can cooked chicken stay in the fridge? | Not sent. The run stopped on the 401 above. |

Configured model: `openai/gpt-oss-120b` at `https://api.groq.com/openai/v1`.

Checked 2026-10-08. The calorie question is expected to decline, and the chicken question is expected to be allowed, once the key is accepted. Re-run with `npx tsx scripts/scopeCheck.ts`.
