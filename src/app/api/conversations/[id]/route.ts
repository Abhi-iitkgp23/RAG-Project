import { NextResponse } from "next/server";
import {
  conversationResponse,
  getConversationStore,
} from "../../../../lib/store";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Restore a thread. An id that was never created is 404. */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const { id } = await context.params;
  const store = getConversationStore();
  const conversation = store.getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Unknown conversation" }, { status: 404 });
  }
  return NextResponse.json(conversationResponse(store, conversation));
}

/** Delete one conversation and its messages. An unknown id is 404. */
export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const { id } = await context.params;
  const store = getConversationStore();
  if (!store.deleteConversation(id)) {
    return NextResponse.json({ error: "Unknown conversation" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
