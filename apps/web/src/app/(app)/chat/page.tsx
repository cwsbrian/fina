import { redirect } from "next/navigation";

export default function ChatPage() {
  redirect("/home?chat=open");
}
