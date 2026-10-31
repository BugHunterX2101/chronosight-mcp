import type { Metadata } from "next";
import { AdminConsole } from "../../components/AdminConsole.tsx";

export const metadata: Metadata = { title: "Admin · Chronosight", robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <main className="shell">
      <h1>Admin</h1>
      <AdminConsole />
    </main>
  );
}
