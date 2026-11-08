// Administration (screen 13): content, invitations, users and the audit log.
// "Remove" hides and keeps the files; deleting for good is command line only.
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { Badge, Field, Skeleton, useToast } from "../../components/ui";
import { useI18n } from "../../i18n/i18n";
import * as api from "../../lib/api";
import type { AdminPlace, AdminUser, AuditEntry, ContentPage, ContentRow, Invitation } from "../../lib/api";
import { useRouter } from "../../lib/router";
import { useAuth } from "../auth/AuthContext";

import "./admin.css";

type Tab = "content" | "invitations" | "users" | "audit";
const TABS: Tab[] = ["content", "invitations", "users", "audit"];

type Target = { kind: "recording"; row: ContentRow } | { kind: "place"; row: AdminPlace };

function StatusBadge({ row }: { row: ContentRow }) {
  const { t } = useI18n();
  if (row.status === "removed") return <Badge tone="danger" icon="alert">{t("admin.status.removed")}</Badge>;
  if ((row.report_count ?? 0) > 0) return <Badge tone="warning" icon="flag">{t("admin.status.reported")}</Badge>;
  if (row.status === "ready") return <Badge tone="success" icon="check">{t("admin.status.published")}</Badge>;
  if (row.status === "failed") return <Badge tone="danger" icon="alert">{t("recording.status.failed")}</Badge>;
  return <Badge tone="warning" icon="timer">{t("recording.status.processing")}</Badge>;
}

function RemovePanel({ target, onDone, onCancel }: { target: Target; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const name = target.kind === "recording" ? target.row.title : target.row.name;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError(t("admin.reasonRequired"));
      return;
    }
    try {
      if (target.kind === "recording") await api.removeContent(target.row.id, reason.trim());
      else await api.removeAdminPlace(target.row.id, reason.trim());
      onDone();
    } catch {
      setError(t("admin.actionFailed"));
    }
  }

  return (
    <form className="card admin-remove" onSubmit={submit} noValidate>
      <h2 className="card__heading">{t("admin.removeTitle", { name })}</h2>
      <p>{t("admin.removeBody")}</p>
      <Field label={t("admin.reason")} error={error}>
        {(props) => <input {...props} className="input" autoFocus maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div className="actions">
        <button type="submit" className="sa-btn sa-btn--danger">
          <Icon name="trash" size={20} />
          {t("admin.remove")}
        </button>
        <button type="button" className="sa-btn sa-btn--quiet" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function ContentTab() {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<ContentPage | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  const load = useCallback(() => {
    api.getContent().then(setData).catch(() => setData({ recordings: [], places: [] }));
  }, []);
  useEffect(load, [load]);

  if (!data) return <Skeleton label={t("common.loading")} />;

  async function act(call: () => Promise<unknown>, message: string) {
    await call();
    toast(message);
    load();
  }

  return (
    <div className="admin-columns">
      <div className="admin-main">
        <section className="card" aria-labelledby="admin-recordings">
          <h2 id="admin-recordings" className="card__heading">
            {t("admin.recordings")}
          </h2>
          {data.recordings.length === 0 ? (
            <p className="caption">{t("admin.emptyRecordings")}</p>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th scope="col">{t("admin.col.recording")}</th>
                    <th scope="col">{t("admin.col.place")}</th>
                    <th scope="col">{t("admin.col.author")}</th>
                    <th scope="col">{t("admin.col.status")}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t("admin.col.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recordings.map((row) => (
                    <tr key={row.id} data-testid="admin-row">
                      <td>
                        <a href={`/recordings/${row.id}`}>{row.title}</a>
                        {row.reports.map((report) => (
                          <p key={report.id} className="caption">
                            {t("admin.reportSays", { reason: report.reason })}
                          </p>
                        ))}
                        {row.removed_reason && <p className="caption">{t("admin.removedBecause", { reason: row.removed_reason })}</p>}
                      </td>
                      <td>{row.place_name}</td>
                      <td>{row.author_name ?? "—"}</td>
                      <td>
                        <StatusBadge row={row} />
                      </td>
                      <td className="admin-actions">
                        {row.status === "removed" ? (
                          <button type="button" className="sa-btn" onClick={() => act(() => api.restoreContent(row.id), t("admin.restored"))}>
                            {t("admin.restore")}
                          </button>
                        ) : (
                          <>
                            {(row.report_count ?? 0) > 0 && (
                              <button type="button" className="sa-btn" onClick={() => act(() => api.resolveReports(row.id), t("admin.resolved"))}>
                                {t("admin.resolve")}
                              </button>
                            )}
                            <button type="button" className="sa-btn sa-btn--danger" onClick={() => setTarget({ kind: "recording", row })}>
                              <Icon name="trash" size={20} />
                              {t("admin.remove")}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="admin-places">
          <h2 id="admin-places" className="card__heading">
            {t("admin.places")}
          </h2>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">{t("admin.col.place")}</th>
                  <th scope="col">{t("admin.col.author")}</th>
                  <th scope="col">{t("admin.col.status")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("admin.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.places.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.name}
                      {row.removed_reason && <p className="caption">{t("admin.removedBecause", { reason: row.removed_reason })}</p>}
                    </td>
                    <td>{row.author_name ?? "—"}</td>
                    <td>
                      {row.removed_at ? (
                        <Badge tone="danger" icon="alert">
                          {t("admin.status.removed")}
                        </Badge>
                      ) : (
                        <Badge tone="success" icon="check">
                          {t("admin.status.published")}
                        </Badge>
                      )}
                    </td>
                    <td className="admin-actions">
                      {row.removed_at ? (
                        <button type="button" className="sa-btn" onClick={() => act(() => api.restoreAdminPlace(row.id), t("admin.restored"))}>
                          {t("admin.restore")}
                        </button>
                      ) : (
                        <button type="button" className="sa-btn sa-btn--danger" onClick={() => setTarget({ kind: "place", row })}>
                          <Icon name="trash" size={20} />
                          {t("admin.remove")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {target && (
        <RemovePanel
          key={target.row.id}
          target={target}
          onCancel={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            toast(t("admin.removed"));
            load();
          }}
        />
      )}
    </div>
  );
}

function invitationState(invitation: Invitation, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (invitation.revoked_at) return <Badge tone="danger">{t("admin.invitation.revoked")}</Badge>;
  if (invitation.used_at) return <Badge icon="check">{t("admin.invitation.used")}</Badge>;
  if (new Date(invitation.expires_at) <= new Date()) return <Badge tone="warning">{t("admin.invitation.expired")}</Badge>;
  return <Badge tone="success" icon="check">{t("admin.invitation.unused")}</Badge>;
}

function InvitationsTab() {
  const { t, formatDateShort } = useI18n();
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getInvitations().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function create() {
    const invitation = await api.createInvitation(7);
    setCreated(invitation.code ?? null);
    load();
  }

  return (
    <section className="card" aria-labelledby="admin-invitations">
      <div className="page__bar">
        <h2 id="admin-invitations" className="card__heading">
          {t("admin.tab.invitations")}
        </h2>
        <button type="button" className="sa-btn sa-btn--primary" onClick={create}>
          {t("admin.invitation.create")}
        </button>
      </div>
      {created && (
        <div className="notice" role="status">
          <p>{t("admin.invitation.onlyOnce")}</p>
          <p className="timecode" data-testid="new-invitation">
            {created}
          </p>
        </div>
      )}
      {!items ? (
        <Skeleton label={t("common.loading")} />
      ) : (
        <ul className="admin-list">
          {items.map((invitation) => (
            <li key={invitation.id}>
              <span className="meta">{invitation.code_hint}…</span>
              <span className="caption">
                {invitation.used_at
                  ? t("admin.invitation.usedBy", { name: invitation.used_by_name ?? "—", date: formatDateShort(invitation.used_at) })
                  : t("admin.invitation.expires", { date: formatDateShort(invitation.expires_at) })}
              </span>
              <span className="admin-list__end">
                {invitationState(invitation, t)}
                {!invitation.used_at && !invitation.revoked_at && (
                  <button
                    type="button"
                    className="sa-btn sa-btn--quiet"
                    onClick={async () => {
                      await api.revokeInvitation(invitation.id);
                      load();
                    }}
                  >
                    {t("admin.invitation.revoke")}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsersTab() {
  const { t, formatDateShort } = useI18n();
  const { user } = useAuth();
  const [items, setItems] = useState<AdminUser[] | null>(null);
  const load = useCallback(() => {
    api.getUsers().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  if (!items) return <Skeleton label={t("common.loading")} />;
  return (
    <section className="card" aria-label={t("admin.tab.users")}>
      <ul className="admin-list">
        {items.map((item) => (
          <li key={item.id} data-testid="admin-user">
            <span>{item.username}</span>
            <span className="caption">
              {item.role === "admin" ? t("admin.user.admin") : t("admin.user.user")} · {t("admin.user.since", { date: formatDateShort(item.created_at) })}
            </span>
            <span className="admin-list__end">
              {item.is_active ? <Badge tone="success" icon="check">{t("admin.user.active")}</Badge> : <Badge tone="danger">{t("admin.user.inactive")}</Badge>}
              {item.id !== user?.id && (
                <button
                  type="button"
                  className="sa-btn"
                  onClick={async () => {
                    await (item.is_active ? api.deactivateUser(item.id) : api.reactivateUser(item.id));
                    load();
                  }}
                >
                  {t(item.is_active ? "admin.user.deactivate" : "admin.user.reactivate")}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AuditTab() {
  const { t, formatDateTime } = useI18n();
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.getAudit().then(setItems).catch(() => setItems([]));
  }, []);
  if (!items) return <Skeleton label={t("common.loading")} />;
  return (
    <section className="card" aria-label={t("admin.tab.audit")}>
      <ul className="admin-list">
        {items.map((entry) => (
          <li key={entry.id}>
            <span className="meta">{formatDateTime(entry.at)}</span>
            <span>{entry.actor_name ?? t("admin.audit.system")}</span>
            <span className="meta">{entry.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminPage() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [tab, setTab] = useState<Tab>("content");
  return (
    <div className="page">
      <div className="page__inner page__inner--wide">
        <div className="page__bar">
          <button type="button" className="sa-btn sa-btn--quiet" onClick={() => navigate("/")}>
            <span className="icon-back">
              <Icon name="chevron" size={20} />
            </span>
            {t("common.back")}
          </button>
        </div>
        <h1 className="admin-title">{t("admin.title")}</h1>
        <nav aria-label={t("admin.sections")}>
          <div className="sa-switch">
            {TABS.map((name) => (
              <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>
                {t(`admin.tab.${name}`)}
              </button>
            ))}
          </div>
        </nav>
        {tab === "content" && <ContentTab />}
        {tab === "invitations" && <InvitationsTab />}
        {tab === "users" && <UsersTab />}
        {tab === "audit" && <AuditTab />}
      </div>
    </div>
  );
}
