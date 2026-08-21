import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsForm } from "@/components/settings/settings-form";
import { requireSession } from "@/lib/auth/require-session";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = { title: "Settings", robots: NOINDEX };

export default async function SettingsPage() {
  const session = await requireSession();
  const user = session.user;

  return (
    <div className="mx-auto max-w-lg px-4 py-8 sm:px-6">
      <div className="border-b border-border/60 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsForm initialName={user.name ?? ""} email={user.email ?? ""} />
        </CardContent>
      </Card>
    </div>
  );
}
