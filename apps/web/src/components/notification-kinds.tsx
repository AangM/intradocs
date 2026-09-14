/**
 * The seven kinds app.notifications can hold (migration 005), each with the words a
 * reader would use, an icon, and the flow colour it belongs to: review (amber) for
 * things waiting on someone, ok (green) for things that went through, block (red) for
 * things that need attention now, info (blue) for the rest.
 */
export const NOTIFICATION_KINDS: Record<string, { label: string; icon: string; tone: string }> = {
  review_assigned: { label: 'Anda ditugaskan mereview', icon: 'flow', tone: 'nt-review' },
  review_decided: { label: 'Review diputuskan', icon: 'check-c', tone: 'nt-ok' },
  published: { label: 'Terpublikasi', icon: 'zap', tone: 'nt-ok' },
  review_due: { label: 'Review berkala jatuh tempo', icon: 'clock', tone: 'nt-review' },
  expired: { label: 'Kedaluwarsa', icon: 'alert', tone: 'nt-block' },
  feedback: { label: 'Masukan pembaca baru', icon: 'msg', tone: 'nt-info' },
  index_failed: {
    label: 'Indeks gagal — publikasi diulang otomatis',
    icon: 'refresh',
    tone: 'nt-block',
  },
  default: { label: 'Pemberitahuan', icon: 'bell', tone: 'nt-info' },
};
export type NotificationItem = {
  id: string;
  kind: string;
  read: boolean;
  title: string;
  documentId: string;
  slug: string;
  versionId: string;
  /** Already formatted on the server ("2 jam lalu"), so the client never touches dates. */
  when: string;
};
