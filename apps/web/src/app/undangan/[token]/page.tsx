import { redirect } from 'next/navigation';
import { currentActor } from '@/lib/session';
import { openInvitation } from '@intradocs/db/invitations';
import { AcceptInvitation } from '@/components/accept-invitation';
import { Icon } from '@/components/icon';
export const dynamic = 'force-dynamic';

/**
 * The acceptance page for a local invitation. Public by necessity -- the person has no
 * account yet -- but it shows only what the invitation itself says about them, and only
 * while the token is open. A signed-in visitor is sent to the portal instead.
 */
export default async function Undangan({ params }: { params: Promise<{ token: string }> }) {
  if (await currentActor()) redirect('/help-center');
  const { token } = await params;
  const invitation = await openInvitation(token);
  return (
    <main className="login-page invite-page">
      <section className="login-card">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="book" />
          </span>
          <span>
            IntraDocs<small>Knowledge Hub · Divisi IT</small>
          </span>
        </div>
        {invitation ? (
          <AcceptInvitation token={token} invitation={invitation} />
        ) : (
          <>
            <h2>Undangan tidak berlaku</h2>
            <p className="sub">
              Tautan ini tidak dikenal, sudah dipakai, dicabut, atau kedaluwarsa (72 jam). Minta
              administrator mengirim undangan baru.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
