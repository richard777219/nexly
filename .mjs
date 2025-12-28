import fs from "fs";
import path from "path";
import { execSync } from "child_process";

function write(filePath, content) {
  const full = path.join(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  console.log("✓", filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), filePath), "utf8"));
}
function writeJson(filePath, obj) {
  fs.writeFileSync(path.join(process.cwd(), filePath), JSON.stringify(obj, null, 2), "utf8");
  console.log("✓", filePath, "(updated)");
}

function run(cmd) {
  console.log("→", cmd);
  execSync(cmd, { stdio: "inherit" });
}

if (!fs.existsSync(path.join(process.cwd(), "package.json"))) {
  console.error("❌ Rode esse script na pasta do seu projeto Next (onde tem package.json).");
  process.exit(1);
}

// 1) .env local pronto
write(
  ".env",
  `# Local (SQLite) — não precisa instalar banco nenhum
DATABASE_URL="file:./dev.db"

NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="troque-por-uma-chave-grande-depois"

GOOGLE_CLIENT_ID="COLOQUE_AQUI"
GOOGLE_CLIENT_SECRET="COLOQUE_AQUI"

NEXLY_CHECKOUT_URL="https://pay.sunize.com.br/ApHAVvjc"
ADMIN_EMAIL="richarddasilvacampos@gmail.com"
`
);

// 2) Prisma schema (SQLite)
write(
  "prisma/schema.prisma",
  `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

enum ProjectStatus {
  DRAFT
  GENERATING
  READY
  ERROR
}

enum CreditTxType {
  FREE_GRANT
  USAGE
  PURCHASE
}

enum PaymentStatus {
  PENDING
  PAID
  FAILED
}

model User {
  id        String   @id @default(cuid())
  name      String?
  email     String?  @unique
  image     String?
  googleId  String?  @unique
  createdAt DateTime @default(now())

  wallet    CreditWallet?
  projects  Project[]
  payments  Payment[]
  txs       CreditTransaction[]
}

model CreditWallet {
  userId    String   @id
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  balance   Int      @default(0)
  updatedAt DateTime @updatedAt
}

model CreditTransaction {
  id        String      @id @default(cuid())
  userId    String
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  type      CreditTxType
  amount    Int
  projectId String?
  createdAt DateTime    @default(now())
}

model Project {
  id          String        @id @default(cuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  title       String
  description String
  status      ProjectStatus @default(DRAFT)

  messages    ProjectMessage[]

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model ProjectMessage {
  id          String   @id @default(cuid())
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  role        String
  content     String
  creditsUsed Int      @default(0)

  createdAt DateTime @default(now())
}

model Payment {
  id             String        @id @default(cuid())
  userId         String
  user           User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  provider       String        @default("SUNIZE")
  status         PaymentStatus @default(PENDING)
  creditsGranted Int           @default(100000)

  externalRef    String?
  createdAt      DateTime      @default(now())
}
`
);

// 3) Copia o mesmo conteúdo do setup “Postgres”, mas a lógica é igual
write("src/lib/prisma.ts", `import { PrismaClient } from "@prisma/client";
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ["error","warn"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
`);

write("src/lib/credits.ts", `import { prisma } from "@/lib/prisma";

export async function getIsPro(userId: string) {
  const paid = await prisma.payment.findFirst({
    where: { userId, status: "PAID" },
    select: { id: true },
  });
  return !!paid;
}

export async function debitCredits(params: { userId: string; amount: number; projectId?: string }) {
  const { userId, amount, projectId } = params;
  if (amount <= 0) return;

  const wallet = await prisma.creditWallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error("WALLET_NOT_FOUND");
  if (wallet.balance < amount) throw new Error("INSUFFICIENT_CREDITS");

  await prisma.$transaction([
    prisma.creditTransaction.create({ data: { userId, type: "USAGE", amount: -amount, projectId } }),
    prisma.creditWallet.update({ where: { userId }, data: { balance: { decrement: amount } } }),
  ]);
}

export async function grantPurchaseCredits(params: { userId: string; credits: number; externalRef?: string }) {
  const { userId, credits, externalRef } = params;

  await prisma.$transaction([
    prisma.payment.create({
      data: { userId, status: "PAID", creditsGranted: credits, externalRef, provider: "SUNIZE" },
    }),
    prisma.creditTransaction.create({ data: { userId, type: "PURCHASE", amount: credits } }),
    prisma.creditWallet.update({ where: { userId }, data: { balance: { increment: credits } } }),
  ]);
}
`);

write("src/app/api/auth/[...nextauth]/route.ts", `import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, account }) {
      if (!account || account.provider !== "google") return false;
      const email = user.email ?? "";
      if (!email) return false;

      const dbUser = await prisma.user.upsert({
        where: { email },
        update: {
          name: user.name ?? undefined,
          image: user.image ?? undefined,
          googleId: account.providerAccountId,
        },
        create: {
          email,
          name: user.name ?? undefined,
          image: user.image ?? undefined,
          googleId: account.providerAccountId,
          wallet: { create: { balance: 0 } },
        },
        include: { wallet: true },
      });

      const alreadyGranted = await prisma.creditTransaction.findFirst({
        where: { userId: dbUser.id, type: "FREE_GRANT" },
        select: { id: true },
      });

      if (!alreadyGranted) {
        await prisma.$transaction([
          prisma.creditTransaction.create({ data: { userId: dbUser.id, type: "FREE_GRANT", amount: 1000 } }),
          prisma.creditWallet.update({ where: { userId: dbUser.id }, data: { balance: { increment: 1000 } } }),
        ]);
      }

      return true;
    },
  },
});

export { handler as GET, handler as POST };
`);

write("src/app/api/me/route.ts", `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { getIsPro } from "@/lib/credits";

export async function GET() {
  const session = await getServerSession();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email }, include: { wallet: true } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  const isPro = await getIsPro(user.id);

  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, image: user.image },
    credits: user.wallet?.balance ?? 0,
    isPro,
    checkoutUrl: process.env.NEXLY_CHECKOUT_URL,
    adminEmail: process.env.ADMIN_EMAIL,
  });
}
`);

write("src/app/api/projects/route.ts", `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const session = await getServerSession();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  const body = await req.json();
  const title = String(body?.title ?? "Novo projeto");
  const description = String(body?.description ?? "");

  const project = await prisma.project.create({
    data: { userId: user.id, title, description, status: "DRAFT" },
    select: { id: true },
  });

  return NextResponse.json({ id: project.id });
}
`);

write("src/app/api/projects/[id]/route.ts", `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  const project = await prisma.project.findFirst({
    where: { id: params.id, userId: user.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json({ project });
}
`);

write("src/app/api/projects/[id]/messages/route.ts", `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { debitCredits } from "@/lib/credits";

function fakeAgentReply(userPrompt: string) {
  return \`✅ Entendi. Vou estruturar seu projeto baseado nisso:

"\${userPrompt}"

Próximos passos:
1) Telas principais
2) Fluxo do app
3) Banco de dados
4) Login Google
5) Deploy

Me diga: você quer "Site" ou "SaaS"?\`;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email }, include: { wallet: true } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  const project = await prisma.project.findFirst({
    where: { id: params.id, userId: user.id },
    select: { id: true },
  });
  if (!project) return NextResponse.json({ error: "PROJECT_NOT_FOUND" }, { status: 404 });

  const body = await req.json();
  const content = String(body?.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "EMPTY_MESSAGE" }, { status: 400 });

  const COST = 100;

  try {
    await debitCredits({ userId: user.id, amount: COST, projectId: project.id });
  } catch {
    return NextResponse.json({ error: "INSUFFICIENT_CREDITS" }, { status: 402 });
  }

  const agentReply = fakeAgentReply(content);

  await prisma.$transaction([
    prisma.projectMessage.create({ data: { projectId: project.id, role: "user", content, creditsUsed: COST } }),
    prisma.projectMessage.create({ data: { projectId: project.id, role: "agent", content: agentReply, creditsUsed: 0 } }),
    prisma.project.update({ where: { id: project.id }, data: { status: "READY" } }),
  ]);

  return NextResponse.json({ ok: true });
}
`);

write("src/app/api/admin/grant-credits/route.ts", `import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { grantPurchaseCredits } from "@/lib/credits";

export async function POST(req: Request) {
  const session = await getServerSession();
  const callerEmail = session?.user?.email?.toLowerCase();

  const adminEmail = (process.env.ADMIN_EMAIL ?? "").toLowerCase();
  if (!callerEmail || !adminEmail || callerEmail !== adminEmail) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const targetEmail = String(body?.email ?? "").trim().toLowerCase();
  const externalRef = body?.externalRef ? String(body.externalRef) : undefined;

  if (!targetEmail) return NextResponse.json({ error: "MISSING_EMAIL" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: targetEmail } });
  if (!user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });

  if (externalRef) {
    const already = await prisma.payment.findFirst({
      where: { externalRef, status: "PAID" },
      select: { id: true },
    });
    if (already) return NextResponse.json({ ok: true, message: "Já creditado antes (externalRef)" });
  }

  await grantPurchaseCredits({ userId: user.id, credits: 100000, externalRef });

  return NextResponse.json({ ok: true, message: "Créditos adicionados: 100000" });
}
`);

write("src/app/page.tsx", `import Link from "next/link";
import Image from "next/image";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 760, width: "100%", textAlign: "center" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 18 }}>
          <Image src="/nexly-logo.png" alt="Nexly" width={72} height={72} />
          <h1 style={{ fontSize: 48, fontWeight: 900, margin: 0 }}>Nexly</h1>
        </div>

        <p style={{ fontSize: 18, color: "#555", marginBottom: 26 }}>
          Crie sites e SaaS (apps web) com IA. Login Google, projetos salvos, créditos e pagamento.
        </p>

        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link href="/api/auth/signin" style={{ background: "#000", color: "#fff", padding: "12px 18px", borderRadius: 12, textDecoration: "none", fontWeight: 900 }}>
            Entrar com Google
          </Link>
          <Link href="/dashboard" style={{ border: "1px solid #ddd", padding: "12px 18px", borderRadius: 12, textDecoration: "none", color: "#000", fontWeight: 900 }}>
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
`);

write("src/app/dashboard/page.tsx", `"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Project = { id: string; title: string; status: string; createdAt: string; updatedAt: string; };

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [credits, setCredits] = useState(0);
  const [isPro, setIsPro] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | undefined>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [prompt, setPrompt] = useState("");
  const [userEmail, setUserEmail] = useState("");

  async function load() {
    setLoading(true);
    const meRes = await fetch("/api/me");
    if (meRes.status === 401) { window.location.href = "/api/auth/signin"; return; }
    const me = await meRes.json();

    setCredits(me.credits ?? 0);
    setIsPro(!!me.isPro);
    setCheckoutUrl(me.checkoutUrl);
    setUserEmail(me?.user?.email ?? "");

    const pRes = await fetch("/api/projects");
    const p = await pRes.json();
    setProjects(p.projects ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createProject() {
    const title = prompt.trim().slice(0, 60) || "Novo projeto";
    const description = prompt.trim();
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) return alert("Erro ao criar projeto");
    const data = await res.json();
    window.location.href = \`/projects/\${data.id}\`;
  }

  if (loading) return <div style={{ padding: 24 }}>Carregando…</div>;

  return (
    <main style={{ minHeight: "100vh", padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 32, fontWeight: 900, margin: 0 }}>Dashboard</h1>
          <p style={{ color: "#666", marginTop: 6 }}>{isPro ? "Pro (sem marca d’água)" : "Free (com marca d’água Nexly)"}</p>
          <p style={{ color: "#777", marginTop: 6, fontSize: 12 }}>Logado como: <b>{userEmail}</b></p>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: "10px 14px" }}>
            <div style={{ fontSize: 12, color: "#777" }}>Créditos</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{credits}</div>
          </div>

          {checkoutUrl && (
            <a href={checkoutUrl} target="_blank" rel="noreferrer"
              style={{ background: "#000", color: "#fff", padding: "12px 14px", borderRadius: 12, textDecoration: "none", fontWeight: 900 }}>
              Comprar 100.000 créditos
            </a>
          )}

          <a href="/api/auth/signout" style={{ border: "1px solid #ddd", padding: "12px 14px", borderRadius: 12, textDecoration: "none", color: "#000", fontWeight: 900 }}>
            Sair
          </a>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>Novo Projeto</h2>
          <textarea
            style={{ width: "100%", minHeight: 160, border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
            placeholder="Descreva o que você quer construir (site ou SaaS)..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button onClick={createProject}
            style={{ marginTop: 10, background: "#000", color: "#fff", padding: "12px 14px", border: "none", borderRadius: 12, cursor: "pointer", fontWeight: 900 }}>
            Iniciar projeto
          </button>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 900, marginBottom: 10 }}>Meus Projetos</h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {projects.length === 0 ? (
              <p style={{ color: "#666" }}>Nenhum projeto ainda.</p>
            ) : (
              projects.map((p) => (
                <Link key={p.id} href={\`/projects/\${p.id}\`}
                  style={{ display: "block", border: "1px solid #ddd", borderRadius: 12, padding: 12, textDecoration: "none", color: "#000" }}>
                  <div style={{ fontWeight: 900 }}>{p.title}</div>
                  <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
                    Status: {p.status} • Atualizado: {new Date(p.updatedAt).toLocaleString()}
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
`);

write("src/app/projects/[id]/page.tsx", `"use client";
import { useEffect, useState } from "react";

type Msg = { id: string; role: string; content: string; createdAt: string; };

export default function ProjectPage({ params }: { params: { id: string } }) {
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [credits, setCredits] = useState(0);
  const [isPro, setIsPro] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | undefined>();

  async function load() {
    setLoading(true);

    const meRes = await fetch("/api/me");
    if (meRes.status === 401) { window.location.href = "/api/auth/signin"; return; }
    const me = await meRes.json();
    setCredits(me.credits ?? 0);
    setIsPro(!!me.isPro);
    setCheckoutUrl(me.checkoutUrl);

    const res = await fetch(\`/api/projects/\${params.id}\`);
    if (!res.ok) { alert("Projeto não encontrado"); window.location.href = "/dashboard"; return; }

    const data = await res.json();
    setTitle(data.project.title);
    setMessages(data.project.messages ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [params.id]);

  async function send() {
    const content = text.trim();
    if (!content) return;

    const res = await fetch(\`/api/projects/\${params.id}/messages\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (res.status === 402) {
      alert("Seus créditos acabaram. Compre mais créditos para continuar.");
      return;
    }
    if (!res.ok) { alert("Erro ao enviar"); return; }

    setText("");
    await load();
  }

  if (loading) return <div style={{ padding: 24 }}>Carregando…</div>;

  return (
    <main style={{ minHeight: "100vh", padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, margin: 0 }}>{title}</h1>
          <p style={{ color: "#666", marginTop: 6 }}>
            Créditos: <b>{credits}</b> • {isPro ? "Pro (sem marca d’água)" : "Free (com marca d’água Nexly)"}
          </p>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {checkoutUrl && (
            <a href={checkoutUrl} target="_blank" rel="noreferrer"
              style={{ background: "#000", color: "#fff", padding: "12px 14px", borderRadius: 12, textDecoration: "none", fontWeight: 900 }}>
              Comprar 100.000 créditos
            </a>
          )}
          <a href="/dashboard" style={{ border: "1px solid #ddd", padding: "12px 14px", borderRadius: 12, textDecoration: "none", color: "#000", fontWeight: 900 }}>
            Voltar
          </a>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>Chat do Projeto</h2>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 520, overflow: "auto", border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
            {messages.length === 0 ? (
              <p style={{ color: "#666" }}>Sem mensagens ainda.</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
                  <div style={{ fontSize: 12, color: "#777", marginBottom: 6 }}>{m.role}</div>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "system-ui" }}>{m.content}</pre>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1, border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
              placeholder="Descreva o que você quer..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button onClick={send}
              style={{ background: "#000", color: "#fff", border: "none", borderRadius: 12, padding: "12px 14px", cursor: "pointer", fontWeight: 900 }}>
              Enviar
            </button>
          </div>

          <p style={{ fontSize: 12, color: "#777", marginTop: 8 }}>
            Cada mensagem consome créditos (MVP: 100).
          </p>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 16, padding: 16, position: "relative" }}>
          <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>Preview</h2>

          <div style={{ height: 560, border: "1px solid #eee", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#777", position: "relative", overflow: "hidden" }}>
            <span>Preview (placeholder)</span>

            {!isPro && (
              <div style={{ position: "absolute", bottom: 12, right: 12, fontSize: 14, color: "rgba(0,0,0,0.55)", userSelect: "none", fontWeight: 900 }}>
                Criado com Nexly
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
`);

write("src/app/admin/page.tsx", `"use client";
import { useEffect, useState } from "react";

export default function AdminPage() {
  const [email, setEmail] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  async function checkAccess() {
    const meRes = await fetch("/api/me");
    if (meRes.status === 401) { window.location.href = "/api/auth/signin"; return; }
    const me = await meRes.json();

    const adminEmail = String(me?.adminEmail ?? "").toLowerCase();
    const current = String(me?.user?.email ?? "").toLowerCase();

    if (!adminEmail || current !== adminEmail) {
      alert("Acesso negado.");
      window.location.href = "/dashboard";
      return;
    }
    setChecking(false);
  }

  useEffect(() => { checkAccess(); }, []);

  async function approve() {
    setLoading(true);
    setMsg(null);

    const res = await fetch("/api/admin/grant-credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, externalRef: externalRef.trim() || undefined }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(\`Erro: \${data?.error ?? "Falha"}\`);
      setLoading(false);
      return;
    }

    setMsg(data?.message ?? "OK");
    setLoading(false);
  }

  if (checking) return <div style={{ padding: 24 }}>Verificando acesso…</div>;

  return (
    <main style={{ minHeight: "100vh", padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>Admin (secreto)</h1>
      <p style={{ color: "#666", marginBottom: 18 }}>Após confirmar na Sunize, credite 100.000 no usuário.</p>

      <div style={{ display: "grid", gap: 10 }}>
        <input style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
          placeholder="Email do comprador"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}
          placeholder="externalRef (opcional) - id do pedido Sunize"
          value={externalRef}
          onChange={(e) => setExternalRef(e.target.value)}
        />
        <button onClick={approve} disabled={loading}
          style={{ background: "#000", color: "#fff", padding: "12px 14px", borderRadius: 12, border: "none", cursor: "pointer", fontWeight: 900 }}>
          {loading ? "Aprovando..." : "Aprovar e creditar 100.000"}
        </button>

        {msg && <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>{msg}</div>}
      </div>
    </main>
  );
}
`);

// package.json (prisma on build) - para Vercel
const pkg = readJson("package.json");
pkg.scripts = pkg.scripts || {};
pkg.scripts.postinstall = "prisma generate";
pkg.scripts.build = "prisma migrate deploy && next build";
pkg.scripts.dev = pkg.scripts.dev || "next dev";
pkg.scripts.start = pkg.scripts.start || "next start";
writeJson("package.json", pkg);

console.log("\n✅ Nexly (LOCAL) criado com SQLite e .env pronto.");
console.log("➡️ Agora faça:");
console.log("1) npm install");
console.log("2) npx prisma migrate dev --name init");
console.log("3) npm run dev");
console.log("\n⚠️ Falta você colocar GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env");
