import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError, CredentialsSignin } from "next-auth";
import { signIn, googleSignInEnabled } from "@/lib/auth/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; registered?: string; reset?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl || "/dashboard";

  async function loginWithCredentials(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirectTo: callbackUrl,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        const code = error instanceof CredentialsSignin && error.code === "rate_limited" ? "rate_limited" : "invalid";
        redirect(`/login?error=${code}&callbackUrl=${encodeURIComponent(callbackUrl)}`);
      }
      throw error;
    }
  }

  async function loginWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col justify-center px-4 py-16 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Access your dashboard, watchlist and alerts.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {params.error === "rate_limited" && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Too many sign-in attempts. Wait a few minutes and try again.
            </p>
          )}
          {params.error && params.error !== "rate_limited" && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Invalid email or password.
            </p>
          )}
          {params.registered && (
            <p className="rounded-md bg-[var(--success-text)]/10 px-3 py-2 text-sm text-[var(--success-text)]">
              Account created — sign in below.
            </p>
          )}
          {params.reset && (
            <p className="rounded-md bg-[var(--success-text)]/10 px-3 py-2 text-sm text-[var(--success-text)]">
              Password reset — sign in with your new password.
            </p>
          )}

          {googleSignInEnabled && (
            <>
              <form action={loginWithGoogle}>
                <Button type="submit" variant="outline" className="w-full">
                  Continue with Google
                </Button>
              </form>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground">OR</span>
                <Separator className="flex-1" />
              </div>
            </>
          )}

          <form action={loginWithCredentials} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link href="/forgot-password" className="text-xs text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <Input id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/register" className="text-primary hover:underline">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
