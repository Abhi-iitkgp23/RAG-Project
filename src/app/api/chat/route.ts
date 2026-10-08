import { NextResponse } from "next/server";
import {
  handleChatTurn,
  MESSAGE_REQUIRED,
  resolveChatDependencies,
  RETRY_MESSAGE,
} from "../../../lib/chat";
import { getConversationStore } from "../../../lib/store";

/** One user turn. Prompt text, SQL, and citation formatting live in other modules. */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: MESSAGE_REQUIRED }, { status: 400 });
  }

  try {
    const result = await handleChatTurn(body, {
      store: getConversationStore(),
      ...resolveChatDependencies(),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: RETRY_MESSAGE }, { status: 500 });
  }
}
