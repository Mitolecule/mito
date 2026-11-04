import { auth, db } from "./firebase.js";
import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const ADMIN_EMAIL = "mr.dhalait@gmail.com";
const EMAIL_KEY = "mitolecule-sign-in-email";
const FIRESTORE_WRITE_TIMEOUT_MS = 15000;
const app = document.querySelector("#root");
const state = {
  authLoading: true,
  profileLoading: false,
  profileError: "",
  user: null,
  profile: null,
  view: "Overview",
  email: "",
  linkPending: false,
  authBusy: false,
  authError: "",
  authNotice: "",
  dataError: "",
  toast: "",
  menuOpen: false,
  noticeOpen: false,
  formOpen: false,
  inviteOpen: false,
  inviteRole: "member",
  editingNameUid: "",
  nameEditError: "",
  nameEditBusy: false,
  search: "",
  leaves: [],
  team: [],
  invitations: [],
};
let stopLeaves = () => {};
let stopTeam = () => {};
let stopInvitations = () => {};
let toastTimer;
let authGeneration = 0;
let authStartupTimer;

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function roleName(role) {
  return role === "admin" ? "Workspace admin" : role === "executive" ? "Executive board" : "Team member";
}

function humanError(error) {
  const known = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/too-many-requests": "Too many attempts. Please wait a little and try again.",
    "auth/quota-exceeded": "Firebase has temporarily reached its daily email sign-in limit. Wait for the quota to reset, or review the email link sign-in limits in Firebase Console.",
    "auth/unauthorized-continue-uri": "This site is not configured for email sign-in yet.",
    "auth/unauthorized-domain": "This domain is not authorized for Firebase sign-in yet.",
    "permission-denied": "Firestore denied this request. Confirm the latest firestore.rules are published to this Firebase project.",
    "unavailable": "Firebase is temporarily unavailable. Check your connection and try again.",
    "not-found": "The Firestore database was not found. Create it in the Firebase Console and try again.",
    "app/firestore-write-timeout": "Firestore did not confirm the save. Check your connection, database, and published rules, then try again. The save may still finish if the connection recovers.",
  };
  return known[error?.code] || error?.message || "Something went wrong. Please try again.";
}

function confirmFirestoreWrite(write) {
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = window.setTimeout(() => {
      const error = new Error("Firestore write timed out.");
      error.code = "app/firestore-write-timeout";
      reject(error);
    }, FIRESTORE_WRITE_TIMEOUT_MS);
  });
  return Promise.race([write, timedOut]).finally(() => window.clearTimeout(timeout));
}

function setState(values) {
  Object.assign(state, values);
  render();
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 3800);
}

function initials(name = "") {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "M";
}

function avatar(name, size = "") {
  return `<span class="avatar ${size}">${esc(initials(name))}</span>`;
}

function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "-";
  const date = value?.toDate ? value.toDate() : new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("en", options);
}

function ago(timestamp) {
  if (!timestamp?.toDate) return "Just now";
  const hours = Math.max(0, Math.floor((Date.now() - timestamp.toDate().getTime()) / 3600000));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function sortLeaves(items) {
  return items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
}

function statusPill(status) {
  const label = status === "approved" ? "Approved" : status === "declined" ? "Declined" : "In review";
  return `<span class="status-pill ${esc(status)}"><span></span>${label}</span>`;
}

function navButton(icon, title, badge = "") {
  return `<button class="nav-item ${state.view === title ? "active" : ""}" data-view="${esc(title)}"><span class="nav-icon">${icon}</span><span>${esc(title)}</span>${badge ? `<span class="nav-badge">${badge}</span>` : ""}</button>`;
}

const icons = {
  overview: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  team: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>',
};

function render() {
  const previous = [...app.querySelectorAll("input[name], textarea[name], select[name]")].map((element) => {
    const formId = element.closest("form")?.id || "";
    return { key: `${formId}:${element.name}`, value: element.value, focused: element === document.activeElement };
  });

  if (state.authLoading) {
    app.innerHTML = '<div class="loading-screen"><span class="brand-mark">✳</span><span>Opening your workspace…</span></div>';
    return;
  }
  if (state.profileLoading) {
    app.innerHTML = '<main class="loading-screen"><span class="brand-mark">✳</span><strong>Setting up your workspace</strong><span>Checking your account permissions…</span><button class="button button-secondary" data-action="signout">Sign out</button></main>';
    return;
  }
  if (state.profileError) {
    app.innerHTML = `<main class="loading-screen profile-error"><span class="brand-mark">!</span><strong>We couldn’t open your workspace</strong><p>${esc(state.profileError)}</p><p class="setup-hint">If this is your first sign-in, make sure Cloud Firestore is created and the latest firestore.rules have been published in Firebase Console.</p><div><button class="button button-primary" data-action="retry-profile">Try again</button><button class="button button-secondary" data-action="signout">Sign out</button></div></main>`;
    return;
  }
  if (!state.user || !state.profile) {
    app.innerHTML = renderLogin();
  } else {
    app.innerHTML = renderWorkspace();
  }

  let focusTarget;
  for (const saved of previous) {
    const formId = saved.key.slice(0, saved.key.indexOf(":"));
    const name = saved.key.slice(saved.key.indexOf(":") + 1);
    const selector = formId
      ? `#${CSS.escape(formId)} [name="${CSS.escape(name)}"]`
      : `[name="${CSS.escape(name)}"]`;
    const element = app.querySelector(selector);
    if (element && element.value !== saved.value) element.value = saved.value;
    if (saved.focused) focusTarget = element;
  }
  focusTarget?.focus({ preventScroll: true });

  if (state.search) filterTeamCards(state.search);
}

function renderLogin() {
  const finishing = isSignInWithEmailLink(auth, window.location.href);
  const title = state.linkPending ? "Check your inbox" : finishing ? "Finish signing in" : "Your space, in sync.";
  const description = state.linkPending
    ? `We sent a secure sign-in link to ${esc(state.email)}. Open it on this device to continue.`
    : finishing
      ? "Confirm the email address you used to request the link."
      : "A little more connected. A little more considered.";

  return `<main class="login-shell">
    <section class="login-art">
      <div class="login-brand"><span class="brand-mark">✳</span><span>mitolecule<span class="brand-dot">.</span></span></div>
      <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
      <div class="art-copy"><span class="eyebrow">MITO GROUP</span><h1>Many parts.<br><em>One greater</em><br>whole.</h1><p>We bring people, ideas and independent ventures together to build things that make a meaningful difference.</p><div class="hero-actions"><a class="button button-primary" href="https://mitolecule.github.io" target="_blank" rel="noreferrer">Discover Mitolecule ↗</a><a class="button button-secondary" href="https://mitolecule.github.io/#ventures" target="_blank" rel="noreferrer">Explore our ventures</a></div></div>
      <div class="art-footer"><span>People first. Ideas into action.</span><span>MITO GROUP</span></div>
    </section>
    <section class="login-side">
      <div class="login-form-wrap">
        <div class="login-mobile-brand"><span class="brand-mark">✳</span><span>mitolecule<span class="brand-dot">.</span></span></div>
        <div class="login-heading"><div class="welcome-icon">${icons.team}</div><h2>${state.linkPending ? title : finishing ? title : "Your people space"}</h2><p>${state.linkPending || finishing ? description : "Sign in with your invited work email to continue."}</p></div>
        ${state.authError ? `<div class="inline-alert error-alert">${esc(state.authError)}</div>` : ""}
        ${state.authNotice ? `<div class="inline-alert info-alert">${esc(state.authNotice)}</div>` : ""}
        ${state.linkPending
          ? `<div class="sent-state"><div class="sent-icon">✉</div><button class="button button-secondary" data-action="different-email">Use a different email</button></div>`
          : `<form class="login-form" id="login-form" data-form="login">
              <label for="login-email">Work email</label>
              <div class="input-with-icon"><span>✉</span><input id="login-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" value="${esc(state.email)}"></div>
              <button class="button button-primary login-submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "One moment..." : finishing ? "Continue securely" : "Continue with email"} <span>→</span></button>
            </form>`}
        <div class="login-rule"></div>
        <p class="login-footnote"><span>⌑</span> Private to the Mitolecule team. Access is invitation-only.</p>
        <p class="login-quote">“People should feel that they are part of building something, not just completing tasks for it.”</p>
      </div>
      <div class="login-legal"><span>© ${new Date().getFullYear()} Mitolecule Group</span><span>Thoughtful work, together.</span></div>
    </section>
  </main>`;
}

function renderWorkspace() {
  const board = ["admin", "executive"].includes(state.profile.role);
  const admin = state.profile.role === "admin";
  const pending = state.leaves.filter((item) => item.status === "pending");
  const body = state.view === "Overview" ? renderOverview(board, pending)
    : state.view === "Leave" ? renderLeave(board)
      : state.view === "Team" ? renderTeam(admin)
        : renderGuides();
  const error = state.dataError ? `<div class="inline-alert error-alert">${esc(state.dataError)}<button data-action="dismiss-error" aria-label="Dismiss">×</button></div>` : "";
  const notificationItems = board && pending.length
    ? pending.slice(0, 4).map((request) => `<button class="popover-item" data-view="Leave"><span class="popover-icon">${icons.calendar}</span><span class="popover-copy"><strong>${esc(request.name || request.email)}</strong><small>Applied ${ago(request.createdAt)} · ${formatDate(request.startDate)}</small><small class="popover-reason">${esc(request.reason)}</small></span></button>`).join("")
    : '<p class="empty-popover">You’re all caught up.</p>';

  return `<div class="app-shell">
    <aside class="sidebar ${state.menuOpen ? "sidebar-open" : ""}">
      <div class="sidebar-brand"><span class="brand-mark">✳</span><span class="brand-name">mitolecule<span class="brand-dot">.</span></span><button class="icon-button mobile-close" data-action="close-menu" aria-label="Close menu">×</button></div>
      <div class="workspace-switcher"><div class="workspace-symbol">M</div><div class="workspace-copy"><strong>Mitolecule Group</strong><span>People workspace</span></div><span class="muted">⌄</span></div>
      <nav class="side-nav" aria-label="Main navigation"><span class="nav-label">WORKSPACE</span>
        ${navButton(icons.overview, "Overview")}${navButton(icons.calendar, "Leave", board && pending.length ? pending.length : "")}${navButton(icons.team, "Team")}
        <span class="nav-label nav-label-spaced">YOUR SPACE</span>${navButton(icons.file, "Guides & policies")}
      </nav>
      <div class="sidebar-bottom"><div class="sidebar-note"><span>✳</span><div><strong>People first.</strong><span>Good work starts with trust.</span></div></div>
        <button class="profile-menu" data-action="profile-menu">${avatar(state.profile.displayName || state.user.email, "small")}<span class="profile-copy"><strong>${esc(state.profile.displayName || state.user.email.split("@")[0])}</strong><span>${roleName(state.profile.role)}</span></span><span class="muted">···</span></button>
        ${state.menuOpen ? '<button class="signout-menu" data-action="signout">↗ &nbsp; Sign out</button>' : ""}
      </div>
    </aside>
    <main class="main-panel">
      <header class="topbar"><button class="icon-button mobile-menu" data-action="open-menu" aria-label="Open menu">☰</button><div class="breadcrumbs"><span>Mitolecule</span><span class="crumb-slash">/</span><strong>${esc(state.view)}</strong></div>
        <div class="topbar-actions"><span class="today-date">${icons.calendar} ${new Date().toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" })}</span>
          <button class="icon-button notification-button" data-action="notifications" aria-label="Notifications">♧${board && pending.length ? `<span class="notification-dot">${pending.length > 9 ? "9+" : pending.length}</span>` : ""}</button>
          ${state.noticeOpen ? `<div class="notification-popover"><div class="popover-heading"><strong>Notifications</strong><span>${pending.length} new</span></div>${notificationItems}</div>` : ""}
        </div>
      </header>
      <div class="page-content">${error}${body}</div>
    </main>
    ${state.menuOpen ? '<button class="mobile-scrim" data-action="close-menu" aria-label="Close navigation"></button>' : ""}
    ${state.toast ? `<div class="toast">✓ &nbsp; ${esc(state.toast)}</div>` : ""}
  </div>`;
}

function renderOverview(board, pending) {
  const profile = state.profile;
  const name = profile.displayName?.split(" ")[0] || profile.email.split("@")[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date().toISOString().slice(0, 10);
  const awayToday = state.leaves.filter((item) => item.status === "approved" && item.startDate <= today && item.endDate >= today).length;
  const myPending = state.leaves.filter((item) => item.status === "pending").length;
  const attention = pending.length
    ? `<div class="attention-list">${pending.slice(0, 3).map((request) => `<div class="table-row compact-row"><div class="member-cell">${avatar(request.name || request.email)}<span><strong>${esc(request.name || request.email)}</strong><small>${esc(request.email)}</small></span></div><div class="row-actions"><button class="approve-button" data-action="review" data-id="${esc(request.id)}" data-status="approved" aria-label="Approve request">✓</button><button class="decline-button" data-action="review" data-id="${esc(request.id)}" data-status="declined" aria-label="Decline request">×</button></div><div class="reason-cell"><span>${esc(request.reason)}</span><small>${ago(request.createdAt)}</small></div></div>`).join("")}</div>`
    : `<div class="empty-state compact-empty"><span class="empty-illustration">${icons.calendar}</span><strong>${board ? "Nothing waiting on you" : "A little breathing room"}</strong><span>${board ? "When someone requests time away, you’ll see it here." : "No leave requests yet. You can apply whenever you need a little time."}</span></div>`;
  const ownUpdates = state.leaves.length
    ? `<div class="request-list">${state.leaves.slice(0, 3).map((item) => `<div class="mini-request"><span class="status-mark ${esc(item.status)}">${item.status === "approved" ? "✓" : item.status === "declined" ? "×" : "◷"}</span><span class="mini-copy"><strong>${formatDate(item.startDate)}${item.endDate !== item.startDate ? ` - ${formatDate(item.endDate, { month: "short", day: "numeric" })}` : ""}</strong><small>${item.days} ${item.days === 1 ? "day" : "days"} · ${esc(item.reason)}</small></span>${statusPill(item.status)}</div>`).join("")}</div>`
    : `<div class="empty-state compact-empty"><span class="empty-illustration">${icons.calendar}</span><strong>A little breathing room</strong><span>No leave requests yet. You can apply whenever you need a little time.</span></div>`;
  const preview = state.team.slice(0, 5).map((person, index) => `<div class="team-person">${avatar(person.displayName || person.email)}<span class="team-person-copy"><strong>${esc(person.displayName || person.email.split("@")[0])}</strong><small>${roleName(person.role)}</small></span>${index === 0 && person.role === "admin" ? '<span class="team-status">ADMIN</span>' : ""}</div>`).join("");
  return `<div class="welcome-row"><div><div class="eyebrow muted-eyebrow">${greeting}, ${esc(name)} <span class="greeting-spark">✳</span></div><h1>Your people, <em>in sync.</em></h1><p class="page-subtitle">A little space to take care of the people behind the work.</p></div><button class="button button-primary" data-view="Leave">＋ Request time off</button></div>
    <div class="welcome-banner"><div class="banner-content"><span class="banner-kicker">A NOTE ON HOW WE WORK</span><h2>Ambition without the<br class="desktop-break"> unnecessary pressure.</h2><p>Clear communication, trust, and room to do thoughtful work. That's how we make space for the good ideas.</p><button class="text-button" data-view="Guides & policies">Our people principles →</button></div><div class="banner-art"><div class="banner-sun"></div><div class="banner-shape shape-a"></div><div class="banner-shape shape-b"></div><div class="banner-shape shape-c"></div><span class="banner-art-label">A BETTER WAY<br>TO BUILD</span></div></div>
    <div class="section-heading"><div><h2>Your workspace</h2><span>A healthy team starts with a little clarity.</span></div><span class="section-meta"><span class="live-dot"></span> LIVE</span></div>
    <div class="stat-grid"><div class="stat-card"><div class="stat-icon green">${icons.team}</div><div class="stat-label">People together</div><div class="stat-value">${state.team.length}<span>across the group</span></div><div class="stat-foot"><span class="stat-foot-dot"></span> updated just now</div></div>
      <div class="stat-card"><div class="stat-icon sand">${icons.calendar}</div><div class="stat-label">Out today</div><div class="stat-value">${awayToday}<span>approved time away</span></div><div class="stat-foot"><span class="stat-foot-dot"></span> updated just now</div></div>
      <div class="stat-card"><div class="stat-icon lavender">${icons.overview}</div><div class="stat-label">${board ? "To review" : "Your requests"}</div><div class="stat-value">${board ? pending.length : myPending}<span>${board ? "leave requests waiting" : "awaiting a response"}</span></div><div class="stat-foot"><span class="stat-foot-dot"></span> updated just now</div></div>
    </div>
    <div class="content-grid overview-lower"><section class="surface-card updates-card"><div class="card-heading"><div><h3>${board ? "Needs your attention" : "Your latest updates"}</h3><span>${board ? "A little care goes a long way." : "Your recent time away requests."}</span></div></div>${board ? attention : ownUpdates}<button class="card-link" data-view="Leave">View ${board ? "leave requests" : "all requests"} →</button></section>
      <section class="surface-card team-card"><div class="card-heading"><div><h3>The people behind it</h3><span>Good things happen together.</span></div><button class="icon-button" data-view="Team" aria-label="View all team members">↗</button></div><div class="team-preview">${preview || '<div class="skeleton-line"></div>'}</div><button class="card-link" data-view="Team">Meet the team →</button></section></div>
    <footer class="page-footer"><span>Made for people, by people.</span><span>MITO · GROUP <span class="footer-flower">✳</span></span></footer>`;
}

function renderLeave(board) {
  const pending = state.leaves.filter((item) => item.status === "pending").length;
  const approved = state.leaves.filter((item) => item.status === "approved" && item.createdAt?.toDate?.().getFullYear() === new Date().getFullYear()).length;
  const form = state.formOpen ? `<form class="surface-card leave-form" id="leave-form" data-form="leave"><div class="card-heading"><div><h3>Request time away</h3><span>Your executive team will be notified.</span></div><button class="icon-button" type="button" data-action="close-leave" aria-label="Close">×</button></div>
    ${state.formError ? `<div class="inline-alert error-alert">${esc(state.formError)}</div>` : ""}<div class="form-grid"><label>First day<input name="startDate" type="date" min="${new Date().toISOString().slice(0, 10)}" required></label><label>Last day<input name="endDate" type="date" min="${new Date().toISOString().slice(0, 10)}" required></label></div>
    <label>Anything you'd like us to know?<textarea name="reason" minlength="10" maxlength="1000" required placeholder="Share a little context so the team can plan around your time away." rows="4"></textarea></label>
    <div class="form-footer"><span>⌑ &nbsp; Visible to the executive team</span><button class="button button-primary" ${state.formBusy ? "disabled" : ""}>${state.formBusy ? "Sending…" : "Send request"} →</button></div></form>` : "";
  const requestRows = state.leaves.map((item) => `<div class="table-row"><div class="member-cell">${avatar(item.name || item.email)}<span><strong>${esc(item.name || item.email.split("@")[0])}</strong><small>${esc(item.email)}</small></span></div><div class="date-cell"><strong>${formatDate(item.startDate)}${item.endDate !== item.startDate ? ` - ${formatDate(item.endDate, { month: "short", day: "numeric" })}` : ""}</strong><small>${item.days} ${item.days === 1 ? "day" : "days"}</small></div><div class="reason-cell"><span>${esc(item.reason)}</span><small>${ago(item.createdAt)}</small></div><div>${statusPill(item.status)}</div><div class="row-actions">${item.status === "pending" ? `<button class="approve-button" data-action="review" data-id="${esc(item.id)}" data-status="approved" aria-label="Approve request">✓</button><button class="decline-button" data-action="review" data-id="${esc(item.id)}" data-status="declined" aria-label="Decline request">×</button>` : '<span class="reviewed-label">Reviewed</span>'}</div></div>`).join("");
  const personalRows = state.leaves.map((item) => `<div class="table-row personal-row"><div class="date-cell"><strong>${formatDate(item.startDate)}${item.endDate !== item.startDate ? ` - ${formatDate(item.endDate, { month: "short", day: "numeric" })}` : ""}</strong><small>${item.days} ${item.days === 1 ? "day" : "days"}</small></div><div class="reason-cell"><span>${esc(item.reason)}</span></div><div>${statusPill(item.status)}</div></div>`).join("");
  const table = state.leaves.length
    ? board
      ? `<div class="requests-table"><div class="table-header"><span>TEAM MEMBER</span><span>DATES</span><span>WHY</span><span>STATUS</span><span></span></div>${requestRows}</div>`
      : `<div class="requests-table personal-table"><div class="table-header"><span>DATES</span><span>WHY</span><span>STATUS</span></div>${personalRows}</div>`
    : `<div class="empty-state"><span class="empty-illustration">${icons.calendar}</span><strong>${board ? "No requests just yet" : "Take the time you need"}</strong><span>${board ? "When someone needs time away, their request will show up here." : "There are no requests yet. When you need a break, let the team know."}${!board ? '<br><br><button class="button button-secondary" data-action="new-leave">Make a request →</button>' : ""}</span></div>`;
  return `<div class="welcome-row page-title-row"><div><div class="eyebrow muted-eyebrow">TIME TO RESET</div><h1>${board ? "Leave & wellbeing" : "A little time away"}</h1><p class="page-subtitle">${board ? "Thoughtful time away starts with a thoughtful response." : "Take the space you need. We’ll take care of the details."}</p></div><button class="button button-primary" data-action="new-leave">＋ New request</button></div>
    ${form}<div class="leave-summary-row"><div class="leave-summary"><div class="summary-icon mint">${icons.calendar}</div><div><span>${board ? "Awaiting review" : "In review"}</span><strong>${pending}</strong></div></div><div class="leave-summary"><div class="summary-icon lavender">✓</div><div><span>Approved this year</span><strong>${approved}</strong></div></div><div class="leave-summary"><div class="summary-icon peach">◷</div><div><span>${board ? "Team requests" : "Your requests"}</span><strong>${state.leaves.length}</strong></div></div></div>
    <section class="surface-card table-card"><div class="card-heading table-heading"><div><h3>${board ? "Time away requests" : "Your requests"}</h3><span>${board ? "Review each request with care and context." : "Only you and the executive team can see these."}</span></div>${board ? '<span class="section-meta"><span class="live-dot"></span> LIVE UPDATES</span>' : ""}</div>${table}</section><div class="privacy-note">⌑ &nbsp; Leave details are only shared with you and the executive board.<span class="privacy-name">${esc(state.profile.displayName || "")}</span></div>`;
}

function renderTeam(admin) {
  const search = state.search.toLowerCase();
  const canEditNames = state.user.email?.toLowerCase() === ADMIN_EMAIL;
  const matches = state.team.filter((person) => `${person.displayName || ""} ${person.email}`.toLowerCase().includes(search));
  const members = matches.map((person) => {
    const icon = person.role === "admin" ? "⌑" : person.role === "executive" ? "✳" : "✦";
    const action = admin && person.uid !== state.user.uid
      ? `<button class="deactivate-button" data-action="${person.active ? "deactivate" : "reactivate"}" data-id="${esc(person.uid)}" data-email="${esc(person.email)}">${person.active ? "Pause access" : "Restore access"}</button>`
      : "";
    const nameAction = canEditNames
      ? state.editingNameUid === person.uid
        ? `<form class="name-edit-form" id="display-name-form" data-id="${esc(person.uid)}"><input name="displayName" aria-label="Display name" maxlength="80" required value="${esc(person.displayName || person.email.split("@")[0])}"><div><button type="button" class="name-edit-button" data-action="cancel-name-edit">Cancel</button><button class="name-edit-button" ${state.nameEditBusy ? "disabled" : ""}>${state.nameEditBusy ? "Saving…" : "Save"}</button></div>${state.nameEditError ? `<small class="name-edit-error">${esc(state.nameEditError)}</small>` : ""}</form>`
        : `<button class="name-edit-button" data-action="edit-name" data-id="${esc(person.uid)}">Edit name</button>`
      : "";
    return `<article class="member-card" data-search="${esc(`${person.displayName || ""} ${person.email}`.toLowerCase())}"><div class="member-card-top">${avatar(person.displayName || person.email)}<span class="active-indicator ${person.active ? "" : "inactive"}" title="${person.active ? "Active" : "Inactive"}"></span></div><strong>${esc(person.displayName || person.email.split("@")[0])}</strong><span class="member-email">${esc(person.email)}</span><span class="role-chip ${esc(person.role)}">${icon} ${roleName(person.role)}</span>${nameAction}${action}</article>`;
  }).join("");
  const inviteList = state.invitations.length
    ? `<div class="invitation-list">${state.invitations.map((invite) => `<div class="invitation-row"><div class="invitation-icon">✉</div><div><strong>${esc(invite.email)}</strong><small>${roleName(invite.role)}</small></div><span class="invite-tag">ACCESS GRANTED</span><button class="remove-invite" data-action="remove-invitation" data-email="${esc(invite.email)}">Remove invite</button></div>`).join("")}</div>`
    : '<div class="empty-inline">No invitations yet. Add a person to get started.</div>';
  return `<div class="welcome-row page-title-row"><div><div class="eyebrow muted-eyebrow">PEOPLE MAKE THE COMPANY</div><h1>The people behind it.</h1><p class="page-subtitle">Many perspectives, one greater whole. Get to know your team.</p></div>${admin ? '<button class="button button-primary" data-action="open-invite">＋ Invite someone</button>' : ""}</div>
    <div class="team-intro-strip"><div class="team-intro-icon">${icons.team}</div><div><strong>Room for good things to grow.</strong><span>Roles help us organise work, they never stop a good idea from being heard.</span></div><span class="team-count">${state.team.length} ${state.team.length === 1 ? "person" : "people"}</span></div>
    <section class="surface-card team-directory"><div class="card-heading directory-heading"><div><h3>Everyone at Mitolecule</h3><span>People first, always.</span></div><div class="search-field">⌕ <input aria-label="Search team" name="teamSearch" placeholder="Find someone…" value="${esc(state.search)}"></div></div><div class="member-grid">${members || '<div class="empty-search">⌕ &nbsp; No teammates found. Try another name or email.</div>'}</div></section>
    ${admin ? `<section class="surface-card invite-list-card"><div class="card-heading"><div><h3>Invitations & access</h3><span>Manage who can join the workspace.</span></div><span class="private-label">⌑ &nbsp; ADMIN ONLY</span></div>${inviteList}</section>` : ""}
    ${admin && state.inviteOpen ? `<div class="modal-backdrop" data-action="backdrop"><form class="invite-modal" id="invite-form" data-form="invite"><button type="button" class="modal-close icon-button" data-action="close-invite" aria-label="Close">×</button><div class="modal-icon">${icons.team}</div><span class="eyebrow muted-eyebrow">GROWING TOGETHER</span><h2>Make room for someone new.</h2><p>Give them access to the Mitolecule people space. They’ll use their email to sign in.</p>${state.inviteError ? `<div class="inline-alert error-alert">${esc(state.inviteError)}</div>` : ""}<label>Email address<input name="email" type="email" placeholder="teammate@company.com" required></label><label>Workspace role<select name="role"><option value="member" ${state.inviteRole === "member" ? "selected" : ""}>Team member</option><option value="executive" ${state.inviteRole === "executive" ? "selected" : ""}>Executive board</option></select></label><div class="modal-footer"><button type="button" class="button button-secondary" data-action="close-invite">Not now</button><button class="button button-primary" ${state.inviteBusy ? "disabled" : ""}>${state.inviteBusy ? "Adding…" : "Grant access"} →</button></div></form></div>` : ""}`;
}

function renderGuides() {
  const principles = [
    ["01", "People first", "Good work starts with people who feel trusted, respected and able to contribute."],
    ["02", "Ideas into action", "We value curiosity, thoughtful experimentation and the patience to build things properly."],
    ["03", "Room to grow", "Each venture has its own purpose, identity and space to develop over time."],
  ];
  return `<div class="welcome-row page-title-row"><div><div class="eyebrow muted-eyebrow">HOW WE WORK</div><h1>A good environment<br><em>is not an extra.</em></h1><p class="page-subtitle">Ambition and a healthy working environment can, and should, go together.</p></div></div>
    <div class="principle-grid">${principles.map(([number, title, text]) => `<article class="surface-card principle-card"><span>${number}</span><div class="principle-decoration">✳</div><h3>${title}</h3><p>${text}</p></article>`).join("")}</div>
    <section class="principle-quote"><span class="quote-mark">“</span><blockquote>People should feel that they are part of building something, not just completing tasks for it.</blockquote><span class="quote-byline">A SIMPLE BELIEF · MITO GROUP</span></section>
    <div class="guides-foot"><span>Clear communication. Trust. Sustainable progress.</span><a href="https://mitolecule.github.io/people/" target="_blank" rel="noreferrer">More about our people ↗</a></div>`;
}

function filterTeamCards(value) {
  app.querySelectorAll(".member-card[data-search]").forEach((card) => {
    card.hidden = !card.dataset.search.includes(value.toLowerCase());
  });
}

async function initializeProfile(user) {
  const userRef = doc(db, "users", user.uid);
  const email = user.email?.toLowerCase();

  if (email === ADMIN_EMAIL) {
    const profile = {
      email,
      role: "admin",
      active: true,
      createdAt: serverTimestamp(),
    };
    await setDoc(userRef, profile, { merge: true });
    return { ...profile, displayName: user.displayName || email.split("@")[0] };
  }

  const existing = await getDoc(userRef);
  if (existing.exists()) {
    const profile = existing.data();
    if (!profile.active) {
      await signOut(auth);
      state.authNotice = "Your account is currently inactive. Please contact the team administrator.";
      return null;
    }
    return profile;
  } else {
    let role = "";
    if (email) {
      const invitation = await getDoc(doc(db, "allowedEmails", email));
      if (invitation.exists()) role = invitation.data().role;
    }
    if (!role) {
      await signOut(auth);
      state.authNotice = "This email doesn't have access yet. Ask a Mitolecule admin to invite you.";
      return null;
    }
    const profile = {
      email,
      displayName: user.displayName || email.split("@")[0],
      role,
      active: true,
      createdAt: serverTimestamp(),
    };
    await setDoc(userRef, profile);
    return profile;
  }
}

function startSubscriptions(user) {
  stopLeaves();
  stopTeam();
  stopInvitations();
  state.dataError = "";
  const board = ["admin", "executive"].includes(state.profile.role);
  const leaveRef = collection(db, "leaveRequests");
  const leaveQuery = board ? leaveRef : query(leaveRef, where("uid", "==", user.uid));
  stopLeaves = onSnapshot(leaveQuery, (snapshot) => {
    state.leaves = sortLeaves(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
    render();
  }, (error) => setState({ dataError: humanError(error) }));
  stopTeam = onSnapshot(collection(db, "users"), (snapshot) => {
    state.team = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }));
    const ownProfile = state.team.find((person) => person.uid === user.uid);
    if (ownProfile) state.profile = { ...state.profile, ...ownProfile };
    render();
  }, (error) => setState({ dataError: humanError(error) }));
  if (state.profile.role === "admin") {
    stopInvitations = onSnapshot(collection(db, "allowedEmails"), (snapshot) => {
      state.invitations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    }, (error) => setState({ dataError: humanError(error) }));
  } else {
    state.invitations = [];
  }
}

authStartupTimer = window.setTimeout(() => {
  if (!state.authLoading) return;
  state.authLoading = false;
  state.authError = "Firebase sign-in did not finish. Check your connection and Firebase Authentication setup, then try again.";
  render();
}, 10000);

onAuthStateChanged(auth, (user) => {
  window.clearTimeout(authStartupTimer);
  const generation = ++authGeneration;
  state.authLoading = false;
  state.authError = "";
  state.profileError = "";
  state.user = user;
  state.profile = null;
  state.profileLoading = Boolean(user);
  if (!user) {
    stopLeaves();
    stopTeam();
    stopInvitations();
    state.leaves = [];
    state.team = [];
    state.invitations = [];
    state.profileLoading = false;
    render();
    return;
  }
  render();
  loadUserProfile(user, generation);
}, (error) => {
  window.clearTimeout(authStartupTimer);
  state.authLoading = false;
  state.profileLoading = false;
  state.authError = humanError(error);
  render();
});

async function loadUserProfile(user, generation) {
  let timeout;
  try {
    const profile = await Promise.race([
      initializeProfile(user),
      new Promise((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("Firestore is taking too long to respond. Check your connection, confirm the Firestore API is enabled for project mitoleculegroup, and verify that the published rules allow this signed-in account.")),
          15000,
        );
      }),
    ]);
    if (generation !== authGeneration) return;
    if (!profile) {
      state.profileLoading = false;
      return;
    }
    state.profile = profile;
    state.profileLoading = false;
    state.linkPending = false;
    state.authNotice = "";
    startSubscriptions(user);
  } catch (error) {
    if (generation !== authGeneration) return;
    state.profileLoading = false;
    state.profileError = humanError(error);
  } finally {
    window.clearTimeout(timeout);
    render();
  }
}

if (isSignInWithEmailLink(auth, window.location.href)) {
  const savedEmail = window.localStorage.getItem(EMAIL_KEY);
  if (savedEmail) {
    state.authBusy = true;
    signInWithEmailLink(auth, savedEmail, window.location.href)
      .then(() => {
        window.localStorage.removeItem(EMAIL_KEY);
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch((error) => setState({ authError: humanError(error) }))
      .finally(() => setState({ authBusy: false }));
  } else {
    state.authNotice = "Enter the email address where you received the sign-in link to finish signing in.";
  }
}

app.addEventListener("input", (event) => {
  if (event.target.name === "email" && event.target.closest("#login-form")) state.email = event.target.value;
  if (event.target.name === "teamSearch") {
    state.search = event.target.value;
    filterTeamCards(state.search);
  }
  if (event.target.name === "displayName") state.nameEditError = "";
});

app.addEventListener("change", (event) => {
  if (event.target.name === "role") state.inviteRole = event.target.value;
});

app.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    state.view = viewButton.dataset.view;
    state.menuOpen = false;
    state.noticeOpen = false;
    state.search = "";
    render();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "open-menu") setState({ menuOpen: true });
  else if (action === "close-menu") setState({ menuOpen: false });
  else if (action === "profile-menu") setState({ menuOpen: !state.menuOpen });
  else if (action === "signout") {
    try { await signOut(auth); setState({ menuOpen: false, view: "Overview" }); }
    catch (error) { setState({ authError: humanError(error) }); }
  } else if (action === "notifications") setState({ noticeOpen: !state.noticeOpen });
  else if (action === "dismiss-error") setState({ dataError: "" });
  else if (action === "new-leave") setState({ formOpen: !state.formOpen, formError: "" });
  else if (action === "close-leave") setState({ formOpen: false, formError: "" });
  else if (action === "open-invite") setState({ inviteOpen: true, inviteError: "" });
  else if (action === "close-invite") setState({ inviteOpen: false, inviteError: "" });
  else if (action === "edit-name") setState({ editingNameUid: button.dataset.id, nameEditError: "" });
  else if (action === "cancel-name-edit") setState({ editingNameUid: "", nameEditError: "" });
  else if (action === "backdrop" && event.target === button) setState({ inviteOpen: false });
  else if (action === "different-email") setState({ linkPending: false, authError: "", authNotice: "" });
  else if (action === "retry-profile" && state.user) {
    const generation = ++authGeneration;
    state.profileError = "";
    state.profileLoading = true;
    render();
    loadUserProfile(state.user, generation);
  }
  else if (action === "review") {
    const request = state.leaves.find((item) => item.id === button.dataset.id);
    if (!request) return;
    try {
      await updateDoc(doc(db, "leaveRequests", request.id), {
        status: button.dataset.status,
        reviewedAt: serverTimestamp(),
        reviewedBy: state.user.email,
      });
      showToast(`Request ${button.dataset.status}.`);
    } catch (error) { setState({ dataError: humanError(error) }); }
  } else if (action === "deactivate" || action === "reactivate") {
    try {
      await updateDoc(doc(db, "users", button.dataset.id), { active: action === "reactivate" });
      showToast(`${button.dataset.email} access has been ${action === "reactivate" ? "restored" : "paused"}.`);
    } catch (error) { setState({ dataError: humanError(error) }); }
  } else if (action === "remove-invitation") {
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "allowedEmails", button.dataset.email));
      const person = state.team.find((item) => item.email === button.dataset.email);
      if (person) batch.update(doc(db, "users", person.uid), { active: false });
      await batch.commit();
      showToast(`Invitation for ${button.dataset.email} removed.`);
    } catch (error) { setState({ dataError: humanError(error) }); }
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  if (form.id === "login-form") {
    const email = String(formData.get("email")).trim().toLowerCase();
    state.email = email;
    state.authError = "";
    state.authNotice = "";
    state.authBusy = true;
    render();
    try {
      if (isSignInWithEmailLink(auth, window.location.href)) {
        await signInWithEmailLink(auth, email, window.location.href);
        window.localStorage.removeItem(EMAIL_KEY);
        window.history.replaceState({}, document.title, window.location.pathname);
      } else {
        await sendSignInLinkToEmail(auth, email, {
          url: `${window.location.origin}${window.location.pathname}`,
          handleCodeInApp: true,
        });
        window.localStorage.setItem(EMAIL_KEY, email);
        state.linkPending = true;
      }
    } catch (error) {
      state.authError = humanError(error);
    } finally {
      state.authBusy = false;
      render();
    }
  } else if (form.id === "leave-form") {
    state.formBusy = true;
    state.formError = "";
    render();
    const startDate = String(formData.get("startDate"));
    const endDate = String(formData.get("endDate"));
    const reason = String(formData.get("reason")).trim();
    try {
      if (startDate > endDate) throw new Error("The end date must be on or after the start date.");
      if (reason.length < 10) throw new Error("Please add a little more detail (at least 10 characters).");
      const first = new Date(`${startDate}T00:00:00Z`);
      const last = new Date(`${endDate}T00:00:00Z`);
      await setDoc(doc(collection(db, "leaveRequests")), {
        uid: state.user.uid,
        email: state.user.email,
        name: state.profile.displayName || state.user.email,
        startDate,
        endDate,
        days: Math.round((last - first) / 86400000) + 1,
        reason,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      state.formOpen = false;
      state.formBusy = false;
      state.view = "Leave";
      showToast("Your leave request is with the executive team.");
    } catch (error) {
      state.formError = humanError(error);
      state.formBusy = false;
      render();
    }
  } else if (form.id === "display-name-form") {
    const displayName = String(formData.get("displayName")).trim();
    if (!displayName || displayName.length > 80) {
      state.nameEditError = "Enter a display name between 1 and 80 characters.";
      render();
      return;
    }
    state.nameEditBusy = true;
    state.nameEditError = "";
    render();
    try {
      await confirmFirestoreWrite(updateDoc(doc(db, "users", form.dataset.id), { displayName }));
      if (form.dataset.id === state.user.uid) state.profile = { ...state.profile, displayName };
      state.editingNameUid = "";
      state.nameEditBusy = false;
      showToast("Display name updated.");
    } catch (error) {
      state.nameEditError = humanError(error);
      state.nameEditBusy = false;
      render();
    }
  } else if (form.id === "invite-form") {
    const email = String(formData.get("email")).trim().toLowerCase();
    const role = String(formData.get("role"));
    state.inviteBusy = true;
    state.inviteError = "";
    render();
    try {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
      await confirmFirestoreWrite(setDoc(doc(db, "allowedEmails", email), {
        email,
        role,
        addedAt: serverTimestamp(),
        addedBy: state.user.email,
      }));
      state.inviteBusy = false;
      state.inviteOpen = false;
      showToast(`${email} can now sign in as ${role === "executive" ? "an executive" : "a team member"}.`);
    } catch (error) {
      state.inviteError = `Could not add ${email}: ${humanError(error)}`;
      state.inviteBusy = false;
      render();
    }
  }
});

render();
