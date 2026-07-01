"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  if (checking) {
    return null;
  }

  if (!user) {
    return null; // redirect already in flight
  }

  return (
    <main className="dashboard-shell">
      <h1>Welcome, {user.name}</h1>
      <p>{user.email}</p>
      <p>
        This is a placeholder dashboard proving the session cookie round-trips end to end.
        Photo library, folders, and search land in Week 3-4 and beyond.
      </p>
      <button className="logout-button" onClick={handleLogout}>
        Log out
      </button>
    </main>
  );
}
