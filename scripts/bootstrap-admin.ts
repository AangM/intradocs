/**
 * The first administrator of a deployment.
 *
 *   pnpm ops:bootstrap-admin --email you@org.example --name "Nama Anda" --unit "Divisi IT"
 *
 * A fresh deployment has no accounts and no public sign-up, so without this there is no
 * way in. It creates exactly one active super admin with a generated password, prints
 * that password once, and refuses to run a second time while an active super admin
 * already exists -- so it cannot be used to quietly add a second owner later.
 *
 * Deliberately not a seed: no categories, no documents, no synthetic corpus. What the
 * organisation puts in is theirs from the first row.
 */
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { loadLocalEnv, reportFailure } from './shared.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Readable, unambiguous, and long enough that nobody is tempted to keep it. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint32Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => alphabet[n % alphabet.length]).join('');
}

async function main(): Promise<void> {
  loadLocalEnv();
  const email = (flag('email') ?? '').trim().toLowerCase();
  const name = (flag('name') ?? '').trim();
  const unit = (flag('unit') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
    throw new Error('Wajib --email yang valid.');
  if (name.length < 2 || name.length > 120) throw new Error('Wajib --name 2–120 karakter.');
  if (unit.length < 2 || unit.length > 80) throw new Error('Wajib --unit 2–80 karakter.');
  // The owner role writes to auth and app schemas at once; this is a one-off admin task,
  // not something the application role may do.
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('Isi DATABASE_ADMIN_URL (role pemilik) untuk perintah ini.');
  const db = new Pool({ connectionString: url, max: 1 });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(719281,1)');
    const existing = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.profiles WHERE role='super_admin' AND active",
    );
    if (existing.rows[0]!.n > 0)
      throw new Error(
        `Sudah ada ${existing.rows[0]!.n} super admin aktif. Tambah pengguna lewat "Undang Pengguna" di portal, bukan perintah ini.`,
      );
    const taken = await client.query('SELECT 1 FROM app.profiles WHERE lower(email)=lower($1)', [
      email,
    ]);
    if (taken.rowCount) throw new Error('Email itu sudah terdaftar.');
    const id = randomUUID();
    const password = generatePassword();
    await client.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
      [id, name, email],
    );
    await client.query(
      'INSERT INTO auth.account(id,"accountId","providerId","userId",issuer,password) VALUES($1,$2,\'credential\',$2,\'local:credential\',$3)',
      [randomUUID(), id, await hashPassword(password)],
    );
    await client.query(
      "INSERT INTO app.profiles(id,name,email,unit,role,active,scope_all) VALUES($1,$2,$3,$4,'super_admin',true,true)",
      [id, name, email, unit],
    );
    await client.query('COMMIT');
    // Printed once, to a terminal, never written to a file: rotating it is one sign-in away.
    console.log(
      [
        '',
        'Super admin pertama dibuat.',
        `  Email    : ${email}`,
        `  Password : ${password}`,
        '',
        'Password ini hanya ditampilkan sekali. Masuk, lalu ganti lewat Pengaturan akun.',
        'Undang pengguna lain dari halaman Pengguna & RBAC, bukan dengan perintah ini.',
      ].join('\n'),
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch(reportFailure);
