"use client";

import {
  Activity,
  AlertTriangle,
  Apple,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleEllipsis,
  CirclePlus,
  Clock3,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Globe2,
  GripVertical,
  Heart,
  Headphones,
  History,
  Home,
  LibraryBig,
  Link2,
  ListFilter,
  ListMusic,
  Lock,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  QrCode,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  SkipForward,
  SmilePlus,
  SlidersHorizontal,
  Sparkles,
  ThumbsUp,
  Timer,
  UserPlus,
  UserRoundCheck,
  Users,
  Volume2,
  WandSparkles,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { buildFairQueue } from "@/lib/room-engine";
import { chooseDeepLinkHandoff } from "@/lib/provider-state-engine";
import type { LiveRoomEventPayload, LiveRoomEventType, StoredLiveRoomEvent } from "@/lib/live-room-events";
import { mergeRoomSnapshot, reduceLiveRoomEvent, type LiveRoomSnapshot, type SnapshotParticipant } from "@/lib/live-room-snapshot";

type View = "home" | "library" | "playlists" | "jams" | "activity" | "settings";
type ModalName =
  | "create-jam"
  | "import"
  | "sync"
  | "enhance"
  | "share"
  | "match"
  | "account"
  | "guest-preview"
  | "publish"
  | "brief"
  | null;
type Platform = "spotify" | "apple" | "both";
type SyncState = "synced" | "review" | "unavailable";

type Track = {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: string;
  platform: Platform;
  confidence: number;
  state: SyncState;
  art: string;
  explicit?: boolean;
};

type Playlist = {
  id: number;
  name: string;
  description: string;
  tracks: number;
  duration: string;
  platform: Platform;
  collaborators: number;
  updated: string;
  sync: "live" | "paused" | "review";
  art: string;
};

type Jam = {
  id: number;
  name: string;
  tracks: number;
  members: string[];
  status: "live" | "quiet" | "scheduled";
  updated: string;
  permission: "Owner" | "Editor";
  access: string;
  fairQueue: boolean;
  template: string;
  lastServedContributor?: string;
};

type RoomBrief = {
  occasion: string;
  direction: string;
  pickLimit: string;
  explicitRule: string;
  versionRule: string;
};

type RoomLaunchState = {
  seedSongAdded: boolean;
  roomShared: boolean;
  guestPreviewed: boolean;
};

type RoomFinishState = {
  previewed: boolean;
  matchResolved: boolean;
  appleNeedsReconnect: boolean;
};

type MusicPreference = "spotify" | "apple" | "ask";
type LiveRoomRole = "host" | "guest";
type LiveRoomPhase = "idle" | "handoff" | "started";
type RealtimeStatus = "connecting" | "connected" | "local";
type ShareExpiry = "24 hours" | "7 days" | "Never";

type RoomCredentials = {
  roomId: string;
  hostToken: string;
  guestToken: string;
  revision: number;
  guestExpiresAtMs: number | null;
  expiryPolicy: ShareExpiry;
};

type SharedGuestCapability = {
  roomId: string;
  guestToken: string;
};

type PendingSuggestion = {
  id: string;
  title: string;
  submittedBy: string;
  service: MusicPreference;
};

type DurableParticipantSession = {
  roomId: string;
  participantId: string;
  nickname: string;
  capabilityRole: LiveRoomRole;
  participantRole: "host" | "editor" | "viewer";
  token: string;
  expiresAtMs: number;
};

const defaultRoomBrief: RoomBrief = {
  occasion: "Friday night at the house",
  direction: "Warm start, big singalongs after 10",
  pickLimit: "3 picks each",
  explicitRule: "Explicit after 10 PM",
  versionRule: "Studio versions",
};

const defaultLaunchState: RoomLaunchState = { seedSongAdded: false, roomShared: false, guestPreviewed: false };
const defaultFinishState: RoomFinishState = { previewed: false, matchResolved: false, appleNeedsReconnect: false };

const roomSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "music-room";
const roomCredentialKey = (room: Pick<Jam, "id" | "name">) => `${room.id}:${roomSlug(room.name)}`;

const createRoomCredentials = (): RoomCredentials => ({
  roomId: `room-${crypto.randomUUID()}`,
  hostToken: `host-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  guestToken: `guest-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  revision: 0,
  guestExpiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1_000,
  expiryPolicy: "7 days",
});

const roomCredentialStorageKey = "unijam.room-capabilities.v1";
const participantJoinNonceKey = (roomId: string, role: LiveRoomRole) => `unijam.participant.${roomId}.${role}.join-nonce`;
const participantIdentityKey = (roomId: string, role: LiveRoomRole) => `unijam.participant.${roomId}.${role}.identity`;

const participantJoinNonce = (roomId: string, role: LiveRoomRole): string => {
  const key = participantJoinNonceKey(roomId, role);
  const existing = window.sessionStorage.getItem(key)?.trim();
  if (existing && existing.length >= 22) return existing;
  const nonce = crypto.randomUUID();
  window.sessionStorage.setItem(key, nonce);
  return nonce;
};

const initialRoomCredentials = (): Record<string, RoomCredentials> => {
  const defaults = Object.fromEntries(initialJams.map((room) => [roomCredentialKey(room), createRoomCredentials()]));
  if (typeof window !== "undefined") {
    try {
      const stored = JSON.parse(window.localStorage.getItem(roomCredentialStorageKey) ?? "null") as Record<string, RoomCredentials> | null;
      if (stored && typeof stored === "object") {
        const migrated = Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, {
          ...value,
          revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
          guestExpiresAtMs: value.guestExpiresAtMs === null || Number.isSafeInteger(value.guestExpiresAtMs)
            ? value.guestExpiresAtMs
            : guestExpiryAt("7 days"),
          expiryPolicy: value.expiryPolicy === "24 hours" || value.expiryPolicy === "Never" ? value.expiryPolicy : "7 days",
        } satisfies RoomCredentials]));
        return { ...defaults, ...migrated };
      }
    } catch {
      // A corrupt device-local cache is replaced with fresh opaque capabilities.
    }
  }
  return defaults;
};

const guestExpiryAt = (choice: ShareExpiry, now = Date.now()): number | null => {
  if (choice === "Never") return null;
  return now + (choice === "24 hours" ? 24 : 24 * 7) * 60 * 60 * 1_000;
};

const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "jams", label: "Rooms", icon: RadioTower },
  { id: "library", label: "Song inbox", icon: LibraryBig },
  { id: "playlists", label: "Destinations", icon: ListMusic },
  { id: "activity", label: "History", icon: Activity },
];

const tracks: Track[] = [
  {
    id: 1,
    title: "Pink + White",
    artist: "Frank Ocean",
    album: "Blonde",
    duration: "3:04",
    platform: "both",
    confidence: 100,
    state: "synced",
    art: "art-a",
  },
  {
    id: 2,
    title: "Dreams",
    artist: "Fleetwood Mac",
    album: "Rumours",
    duration: "4:17",
    platform: "both",
    confidence: 100,
    state: "synced",
    art: "art-b",
  },
  {
    id: 3,
    title: "Nights",
    artist: "Frank Ocean",
    album: "Blonde",
    duration: "5:07",
    platform: "spotify",
    confidence: 96,
    state: "review",
    art: "art-c",
    explicit: true,
  },
  {
    id: 4,
    title: "Anything",
    artist: "Adrianne Lenker",
    album: "songs",
    duration: "3:22",
    platform: "both",
    confidence: 99,
    state: "synced",
    art: "art-d",
  },
  {
    id: 5,
    title: "Sweet Disposition",
    artist: "The Temper Trap",
    album: "Conditions",
    duration: "3:51",
    platform: "both",
    confidence: 100,
    state: "synced",
    art: "art-b",
  },
  {
    id: 6,
    title: "Eventually",
    artist: "Tame Impala",
    album: "Currents",
    duration: "5:19",
    platform: "apple",
    confidence: 91,
    state: "review",
    art: "art-a",
  },
  {
    id: 7,
    title: "Sofia",
    artist: "Clairo",
    album: "Immunity",
    duration: "3:08",
    platform: "both",
    confidence: 100,
    state: "synced",
    art: "art-d",
  },
  {
    id: 8,
    title: "Sunflower",
    artist: "Rex Orange County",
    album: "Sunflower",
    duration: "4:12",
    platform: "both",
    confidence: 98,
    state: "synced",
    art: "art-c",
  },
  {
    id: 9,
    title: "Space Song",
    artist: "Beach House",
    album: "Depression Cherry",
    duration: "5:20",
    platform: "both",
    confidence: 100,
    state: "synced",
    art: "art-a",
  },
  {
    id: 10,
    title: "Intro",
    artist: "The xx",
    album: "xx",
    duration: "2:07",
    platform: "apple",
    confidence: 72,
    state: "unavailable",
    art: "art-b",
  },
];

const initialPlaylists: Playlist[] = [
  {
    id: 1,
    name: "Friday Night Room",
    description: "Good energy, no skips. Built together.",
    tracks: 24,
    duration: "1 hr 38 min",
    platform: "both",
    collaborators: 3,
    updated: "Just now",
    sync: "live",
    art: "mosaic",
  },
  {
    id: 2,
    name: "Sunday Morning",
    description: "Coffee, open windows, nowhere to be.",
    tracks: 42,
    duration: "2 hr 46 min",
    platform: "both",
    collaborators: 1,
    updated: "12 min ago",
    sync: "live",
    art: "art-a",
  },
  {
    id: 3,
    name: "Long Drive Home",
    description: "The songs that make the road shorter.",
    tracks: 67,
    duration: "4 hr 21 min",
    platform: "both",
    collaborators: 5,
    updated: "Yesterday",
    sync: "review",
    art: "art-b",
  },
  {
    id: 4,
    name: "Deep Focus",
    description: "Instrumentals and soft edges.",
    tracks: 89,
    duration: "6 hr 10 min",
    platform: "spotify",
    collaborators: 0,
    updated: "Jul 8",
    sync: "paused",
    art: "art-c",
  },
  {
    id: 5,
    name: "Kitchen Radio",
    description: "For dinner with too many people.",
    tracks: 36,
    duration: "2 hr 14 min",
    platform: "apple",
    collaborators: 2,
    updated: "Jul 6",
    sync: "live",
    art: "art-d",
  },
  {
    id: 6,
    name: "Soft Launch",
    description: "A little cool, still approachable.",
    tracks: 51,
    duration: "3 hr 29 min",
    platform: "both",
    collaborators: 4,
    updated: "Jul 2",
    sync: "live",
    art: "art-a",
  },
];

const initialJams: Jam[] = [
  {
    id: 1,
    name: "Friday Night Room",
    tracks: 24,
    members: ["Mason", "Alex", "Maya"],
    status: "live",
    updated: "Maya added a song just now",
    permission: "Owner",
    access: "Anyone with the link can suggest",
    fairQueue: true,
    template: "House party",
    lastServedContributor: "Maya",
  },
  {
    id: 2,
    name: "Beach Weekend",
    tracks: 48,
    members: ["Mason", "Luke", "Evan", "Sam"],
    status: "quiet",
    updated: "Evan reordered 3 tracks · 2h",
    permission: "Owner",
    access: "Invited people can suggest",
    fairQueue: true,
    template: "Road trip",
    lastServedContributor: "Evan",
  },
  {
    id: 3,
    name: "Studio Picks",
    tracks: 31,
    members: ["Mason", "Nora"],
    status: "scheduled",
    updated: "Listening session Sunday at 8:00 PM",
    permission: "Editor",
    access: "Invited people can suggest",
    fairQueue: false,
    template: "Blank room",
  },
];

const activityItems = [
  {
    id: 1,
    person: "Maya",
    initials: "MY",
    action: "added",
    subject: "Pink + White",
    destination: "Friday Night Room",
    time: "Just now",
    tone: "coral",
  },
  {
    id: 2,
    person: "Alex",
    initials: "AL",
    action: "added",
    subject: "Dreams",
    destination: "Friday Night Room",
    time: "4 min ago",
    tone: "sage",
  },
  {
    id: 3,
    person: "UniJam",
    initials: "UJ",
    action: "matched",
    subject: "38 songs",
    destination: "across both libraries",
    time: "18 min ago",
    tone: "aubergine",
  },
  {
    id: 4,
    person: "Mason",
    initials: "MW",
    action: "created",
    subject: "Sunday Morning",
    destination: "and enabled live sync",
    time: "Yesterday",
    tone: "gold",
  },
  {
    id: 5,
    person: "Evan",
    initials: "EV",
    action: "reordered",
    subject: "3 songs",
    destination: "in Beach Weekend",
    time: "Yesterday",
    tone: "blue",
  },
  {
    id: 6,
    person: "UniJam",
    initials: "UJ",
    action: "resolved",
    subject: "2 regional variants",
    destination: "using your lossless preference",
    time: "Friday",
    tone: "aubergine",
  },
];

const recommendations = [
  { id: 101, title: "Garden Song", artist: "Phoebe Bridgers", reason: "Shared by 2 collaborators", art: "art-d" },
  { id: 102, title: "Bags", artist: "Clairo", reason: "Fits the playlist arc", art: "art-a" },
  { id: 103, title: "The Less I Know the Better", artist: "Tame Impala", reason: "High group affinity", art: "art-b" },
  { id: 104, title: "Redbone", artist: "Childish Gambino", reason: "Bridges tracks 11 and 12", art: "art-c" },
];

function PlatformMark({ platform, small = false }: { platform: Platform; small?: boolean }) {
  if (platform === "both") {
    return (
      <span className={"platform-pair" + (small ? " small" : "")} aria-label="Spotify and Apple Music">
        <span className="service-mark spotify-mark">≋</span>
        <span className="service-mark apple-mark">
          <Apple size={small ? 11 : 14} strokeWidth={2.2} />
        </span>
      </span>
    );
  }
  return (
    <span className={"service-mark " + (platform === "spotify" ? "spotify-mark" : "apple-mark")}>
      {platform === "spotify" ? "≋" : <Apple size={small ? 11 : 14} strokeWidth={2.2} />}
    </span>
  );
}

function Avatar({
  name,
  tone = "coral",
  size = "md",
}: {
  name: string;
  tone?: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
  return (
    <span className={"avatar avatar-" + tone + " avatar-" + size} title={name} aria-label={name}>
      {initials}
    </span>
  );
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span className={"platform-badge " + platform}>
      <PlatformMark platform={platform} small />
      {platform === "both" ? "Both" : platform === "spotify" ? "Spotify" : "Apple Music"}
    </span>
  );
}

function SyncBadge({ state }: { state: Playlist["sync"] }) {
  return (
    <span className={"sync-badge " + state}>
      <span className="status-dot" />
      {state === "live" ? "Prepared" : state === "review" ? "Needs review" : "Paused"}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={"toggle" + (checked ? " checked" : "")}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.requestAnimationFrame(() => {
      const meaningfulControl = modalRef.current?.querySelector<HTMLElement>(
        ".modal-body input:not([disabled]), .modal-body textarea:not([disabled]), .modal-body button:not([disabled])",
      );
      (meaningfulControl ?? closeRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modalRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={modalRef}
        className={"modal-card" + (wide ? " modal-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function TrackArt({ art, large = false }: { art: string; large?: boolean }) {
  return <span className={"track-art " + art + (large ? " large" : "")} aria-hidden="true" />;
}

export default function UniJamApp() {
  const [view, setView] = useState<View>("home");
  const [modal, setModal] = useState<ModalName>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const [modalOpener, setModalOpener] = useState<HTMLElement | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [selectedJam, setSelectedJam] = useState<Jam | null>(initialJams[0]);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<"all" | Platform | "review">("all");
  const [selectedTrackIds, setSelectedTrackIds] = useState<number[]>([]);
  const [playlists, setPlaylists] = useState(initialPlaylists);
  const [jams, setJams] = useState(initialJams);
  const [toast, setToast] = useState<string | null>(null);
  const [createStep, setCreateStep] = useState(1);
  const [jamName, setJamName] = useState("Saturday in Staunton");
  const [jamPermission, setJamPermission] = useState("Anyone with the link can add songs");
  const [roomTemplate, setRoomTemplate] = useState("Road trip");
  const [fairQueue, setFairQueue] = useState(true);
  const [guestStep, setGuestStep] = useState(1);
  const [guestName, setGuestName] = useState("Jordan");
  const [guestSearch, setGuestSearch] = useState("");
  const [guestService, setGuestService] = useState<MusicPreference>("apple");
  const [liveRoomActive, setLiveRoomActive] = useState(false);
  const [liveRoomRole, setLiveRoomRole] = useState<LiveRoomRole>("guest");
  const [listeningMode, setListeningMode] = useState<"speaker" | "native">("speaker");
  const [speakerService, setSpeakerService] = useState<"spotify" | "apple">("spotify");
  const [hostLensService, setHostLensService] = useState<"spotify" | "apple">("spotify");
  const [liveRoomPhase, setLiveRoomPhase] = useState<LiveRoomPhase>("idle");
  const [nowTrackIndex, setNowTrackIndex] = useState(0);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [guestReady, setGuestReady] = useState(false);
  const [reactionCount, setReactionCount] = useState(8);
  const [handoffReceipt, setHandoffReceipt] = useState<{ service: "spotify" | "apple"; trackId: number } | null>(null);
  const [liveComposer, setLiveComposer] = useState("");
  const [pendingSuggestions, setPendingSuggestions] = useState<PendingSuggestion[]>([]);
  const [approvedSuggestions, setApprovedSuggestions] = useState<PendingSuggestion[]>([]);
  const [duplicateVoted, setDuplicateVoted] = useState(false);
  const [liveActivity, setLiveActivity] = useState<string[]>(["Maya joined from Apple Music", "Alex co-signed Dreams"]);
  const [liveParticipants, setLiveParticipants] = useState<SnapshotParticipant[]>([]);
  const [activeParticipantIdsByRoom, setActiveParticipantIdsByRoom] = useState<Record<string, string[]>>({});
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [liveClientId] = useState(() => `client-${crypto.randomUUID()}`);
  const [participantSession, setParticipantSession] = useState<DurableParticipantSession | null>(null);
  const [liveSnapshotsByRoom, setLiveSnapshotsByRoom] = useState<Record<string, LiveRoomSnapshot>>({});
  const [roomCredentials, setRoomCredentials] = useState<Record<string, RoomCredentials>>(initialRoomCredentials);
  const [sharedGuestCapability, setSharedGuestCapability] = useState<SharedGuestCapability | null>(null);
  const [serverGuestCanContribute, setServerGuestCanContribute] = useState<boolean | null>(null);
  const roomEventCursorsRef = useRef<Record<string, number>>({});
  const [quickAddMode, setQuickAddMode] = useState(false);
  const [quickAddStartedEmpty, setQuickAddStartedEmpty] = useState(false);
  const [hostPreviewMode, setHostPreviewMode] = useState(false);
  const [roomLaunchStates, setRoomLaunchStates] = useState<Record<number, RoomLaunchState>>({});
  const [roomBriefs, setRoomBriefs] = useState<Record<number, RoomBrief>>({});
  const [roomFinishStates, setRoomFinishStates] = useState<Record<number, RoomFinishState>>({});
  const [queueVotes, setQueueVotes] = useState<Record<number, number>>({ 2: 6, 3: 5, 4: 4, 5: 3, 6: 3, 7: 2, 8: 2 });
  const [votedTrackIds, setVotedTrackIds] = useState<number[]>([]);
  const [hostApproval, setHostApproval] = useState(true);
  const [roomLocked, setRoomLocked] = useState(false);
  const [selectedMatchId, setSelectedMatchId] = useState<"studio" | "live">("studio");
  const [matchReturnTarget, setMatchReturnTarget] = useState<"publish" | null>(null);
  const [hostQueueOrders, setHostQueueOrders] = useState<Record<number, number[]>>({});
  const [importStep, setImportStep] = useState(1);
  const [importSource, setImportSource] = useState<"spotify" | "apple">("spotify");
  const [syncStep, setSyncStep] = useState(1);
  const [syncProgress, setSyncProgress] = useState(0);
  const [activityFilter, setActivityFilter] = useState("All activity");
  const [recommendationIds, setRecommendationIds] = useState<number[]>([101, 102, 104]);
  const [settingsState, setSettingsState] = useState({
    autoSync: true,
    preferLossless: true,
    excludeExplicit: false,
    keepRegional: false,
    dedupe: true,
    localFirst: false,
    notifications: true,
    listeningPresence: true,
  });

  const selectedRoomId = selectedJam?.id ?? initialJams[0].id;
  const roomBrief = roomBriefs[selectedRoomId] ?? defaultRoomBrief;
  const roomLaunchState = roomLaunchStates[selectedRoomId] ?? defaultLaunchState;
  const { seedSongAdded, roomShared, guestPreviewed } = roomLaunchState;
  const roomFinishState = roomFinishStates[selectedRoomId] ?? defaultFinishState;
  const { previewed: finishPreviewed, matchResolved, appleNeedsReconnect } = roomFinishState;
  const guestCanSuggest = selectedJam?.access.startsWith("Anyone with the link") ?? true;
  const guestCanContribute = (sharedGuestCapability ? serverGuestCanContribute === true : guestCanSuggest) && !roomLocked;
  const permissionAllowsLiveContribution = liveRoomRole === "host" || guestCanContribute;
  const liveActor = liveRoomRole === "host" ? "Mason" : guestName || "Guest";
  const liveSource: MusicPreference = liveRoomRole === "host" ? speakerService : guestService;
  const credentialKey = roomCredentialKey(selectedJam ?? initialJams[0]);
  const hostRoomCredentials = roomCredentials[credentialKey];
  const shareExpiry: ShareExpiry = hostRoomCredentials?.expiryPolicy ?? "7 days";
  const activeRoomId = sharedGuestCapability?.roomId ?? hostRoomCredentials?.roomId ?? `room-local-${credentialKey}`;
  const activeRoomToken = liveRoomRole === "host"
    ? hostRoomCredentials?.hostToken
    : sharedGuestCapability?.guestToken ?? hostRoomCredentials?.guestToken;
  const activeParticipantSession = participantSession?.roomId === activeRoomId &&
    participantSession.capabilityRole === liveRoomRole
    ? participantSession
    : null;
  const activeEventToken = activeParticipantSession?.token;
  const activeEventClientId = activeParticipantSession?.participantId ?? liveClientId;
  const canLiveContribute = permissionAllowsLiveContribution && (!activeRoomToken || activeParticipantSession !== null);
  const activeParticipantIds = activeParticipantIdsByRoom[activeRoomId] ?? [];

  const updateLaunchState = (patch: Partial<RoomLaunchState>) => {
    setRoomLaunchStates((current) => ({ ...current, [selectedRoomId]: { ...(current[selectedRoomId] ?? defaultLaunchState), ...patch } }));
  };

  const updateRoomBrief = (patch: Partial<RoomBrief>) => {
    setRoomBriefs((current) => ({ ...current, [selectedRoomId]: { ...(current[selectedRoomId] ?? defaultRoomBrief), ...patch } }));
  };

  const updateFinishState = (patch: Partial<RoomFinishState>) => {
    setRoomFinishStates((current) => ({ ...current, [selectedRoomId]: { ...(current[selectedRoomId] ?? defaultFinishState), ...patch } }));
  };

  const filteredTracks = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return tracks.filter((track) => {
      const effectiveState: SyncState = track.id === 3 && matchResolved ? "synced" : track.state;
      const effectivePlatform: Platform = track.id === 3 && matchResolved ? "both" : track.platform;
      const matchesSearch =
        !query ||
        track.title.toLowerCase().includes(query) ||
        track.artist.toLowerCase().includes(query) ||
        track.album.toLowerCase().includes(query);
      const matchesFilter =
        libraryFilter === "all" ||
        (libraryFilter === "review" && effectiveState !== "synced") ||
        effectivePlatform === libraryFilter ||
        (libraryFilter !== "review" && effectivePlatform === "both");
      return matchesSearch && matchesFilter;
    });
  }, [libraryFilter, librarySearch, matchResolved]);

  const fairQueueEntries = useMemo(() => {
    const queueItems = tracks.slice(1, 8).map((track, index) => ({
      id: String(track.id),
      contributorId: ["Alex", "Maya", "Nora", "Alex", "Maya", "Jordan", "Nora"][index],
      submittedAtMs: index + 1,
      votes: queueVotes[track.id] ?? 0,
    }));
    if (selectedJam?.fairQueue === false) {
      const storedOrder = hostQueueOrders[selectedRoomId] ?? queueItems.map((item) => Number(item.id));
      const orderIndex = new Map(storedOrder.map((id, index) => [id, index]));
      return [...queueItems]
        .sort((left, right) => (orderIndex.get(Number(left.id)) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(Number(right.id)) ?? Number.MAX_SAFE_INTEGER))
        .map((item, index) => ({ item, position: index + 1, round: 1 }));
    }
    return buildFairQueue(queueItems, { afterContributorId: selectedJam?.lastServedContributor });
  }, [hostQueueOrders, queueVotes, selectedJam?.fairQueue, selectedJam?.lastServedContributor, selectedRoomId]);
  const launchStepCount = [seedSongAdded, roomShared, guestPreviewed].filter(Boolean).length;
  const finishReadyCount = matchResolved ? 4 : 3;
  const hostDecisionCount = tracks.filter((track) => track.state !== "synced" && !(track.id === 3 && matchResolved)).length;
  const liveQueueTracks = tracks.slice(0, 5);
  const currentLiveTrack = liveQueueTracks[nowTrackIndex % liveQueueTracks.length];
  const nextLiveTracks = [1, 2, 3].map((offset) => liveQueueTracks[(nowTrackIndex + offset) % liveQueueTracks.length]);
  const presentParticipants = activeParticipantIds.length > 0
    ? liveParticipants.filter(({ clientId }) => activeParticipantIds.includes(clientId))
    : liveParticipants;
  const readyCount = presentParticipants.filter(({ ready }) => ready).length;

  const serviceSearchUrl = (service: "spotify" | "apple", track: Track) => {
    const query = encodeURIComponent(`${track.title} ${track.artist}`);
    const provider = service === "spotify" ? "spotify" : "apple_music";
    const webUrl = service === "spotify" ? `https://open.spotify.com/search/${query}` : `https://music.apple.com/us/search?term=${query}`;
    const handoff = chooseDeepLinkHandoff({
      surface: "web",
      preferredProvider: provider,
      targets: [{ provider, available: true, webUrl }],
    });
    return handoff.available ? handoff.url : webUrl;
  };

  const applyRemoteLiveEvent = useCallback((event: StoredLiveRoomEvent) => {
    const textValue = (key: string) => typeof event.payload[key] === "string" ? String(event.payload[key]) : "";
    const numberValue = (key: string) => typeof event.payload[key] === "number" ? Number(event.payload[key]) : undefined;
    const activity = (message: string) => setLiveActivity((current) => current[0] === message ? current : [message, ...current]);

    switch (event.type) {
      case "participant_joined":
        activity(`${event.actorName} joined the durable room from ${textValue("service") || "the shared link"}`);
        break;
      case "participant_service_changed":
        activity(`${event.actorName} switched their music-app lens to ${textValue("service") || "ask each time"}`);
        break;
      case "participant_left":
        activity(`${event.actorName} left the room`);
        break;
      case "ready_changed":
        activity(`${event.actorName} is ${event.payload.ready === true ? "ready" : "not ready"} for the current track`);
        break;
      case "reaction_added":
        setReactionCount((count) => count + 1);
        activity(`${event.actorName} reacted to the current track`);
        break;
      case "suggestion_staged": {
        const title = textValue("title");
        if (!title) break;
        const service = textValue("service");
        const suggestion: PendingSuggestion = {
          id: textValue("suggestionId") || `suggestion-${event.sequence}`,
          title,
          submittedBy: event.actorName,
          service: service === "spotify" || service === "apple" ? service : "ask",
        };
        setPendingSuggestions((current) => current.some(({ id }) => id === suggestion.id) ? current : [suggestion, ...current]);
        activity(`${event.actorName} staged ${title}`);
        break;
      }
      case "suggestion_approved": {
        const suggestionId = textValue("suggestionId");
        const title = textValue("title");
        if (!suggestionId || !title) break;
        setPendingSuggestions((current) => current.filter(({ id }) => id !== suggestionId));
        setApprovedSuggestions((current) => current.some(({ id }) => id === suggestionId) ? current : [...current, {
          id: suggestionId,
          title,
          submittedBy: textValue("submittedBy") || event.actorName,
          service: textValue("service") === "spotify" ? "spotify" : textValue("service") === "apple" ? "apple" : "ask",
        }]);
        activity(`${event.actorName} approved ${title} for the next round`);
        break;
      }
      case "suggestion_rejected": {
        const suggestionId = textValue("suggestionId");
        if (suggestionId) setPendingSuggestions((current) => current.filter(({ id }) => id !== suggestionId));
        activity(`${event.actorName} passed on ${textValue("title") || "a staged pick"}`);
        break;
      }
      case "vote_changed": {
        const trackId = numberValue("trackId");
        const delta = numberValue("delta");
        if (trackId !== undefined && delta !== undefined) {
          setQueueVotes((current) => ({ ...current, [trackId]: Math.max(0, (current[trackId] ?? 0) + delta) }));
        }
        activity(`${event.actorName} ${delta === -1 ? "removed a queue vote" : "voted in the shared queue"}`);
        break;
      }
      case "speaker_service_changed": {
        const service = textValue("service");
        if (service !== "spotify" && service !== "apple") break;
        setSpeakerService(service);
        setLiveRoomPhase("idle");
        setStartedAtMs(null);
        setElapsedSeconds(0);
        setHandoffReceipt(null);
        activity(`${event.actorName} switched speaker duty to ${service === "spotify" ? "Spotify" : "Apple Music"}`);
        break;
      }
      case "handoff_requested":
        if (textValue("role") === "host") setLiveRoomPhase("handoff");
        activity(`${event.actorName} requested a ${textValue("service") || "music-app"} handoff`);
        break;
      case "playback_confirmed":
        setLiveRoomPhase("started");
        setStartedAtMs(event.createdAtMs);
        setElapsedSeconds(Math.max(0, Math.floor((Date.now() - event.createdAtMs) / 1_000)));
        activity(`${event.actorName} confirmed the shared-speaker start`);
        break;
      case "track_advanced": {
        const trackIndex = numberValue("trackIndex");
        setNowTrackIndex((current) => trackIndex ?? (current + 1) % 5);
        setLiveRoomPhase("idle");
        setStartedAtMs(null);
        setElapsedSeconds(0);
        setReactionCount(0);
        setHandoffReceipt(null);
        activity(`${event.actorName} advanced the room`);
        break;
      }
    }
  }, []);

  const hydrateLiveSnapshot = useCallback((roomId: string, snapshot: LiveRoomSnapshot, force = false) => {
    setLiveSnapshotsByRoom((current) => mergeRoomSnapshot(current, roomId, snapshot, force));
  }, []);

  const activeLiveSnapshot = liveSnapshotsByRoom[activeRoomId];
  useEffect(() => {
    if (!activeLiveSnapshot) return;
    const snapshot = activeLiveSnapshot;
    const participants = Object.values(snapshot.participants).sort((left, right) => {
      if (left.role !== right.role) return left.role === "host" ? -1 : 1;
      return left.lastSeenAtMs - right.lastSeenAtMs;
    });
    const suggestions = Object.values(snapshot.suggestions);
    const snapshotVotes = Object.fromEntries(
      Object.entries(snapshot.votes)
        .map(([trackId, clientIds]) => [Number(trackId), clientIds.length] as const)
        .filter(([trackId]) => Number.isSafeInteger(trackId)),
    );
    const self = snapshot.participants[activeEventClientId];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLiveRoomPhase(snapshot.phase);
      setSpeakerService(snapshot.speakerService);
      setNowTrackIndex(Math.max(0, snapshot.nowTrackIndex % 5));
      setStartedAtMs(snapshot.startedAtMs);
      setElapsedSeconds(snapshot.startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - snapshot.startedAtMs) / 1_000)));
      setReactionCount(snapshot.reactionCount);
      setLiveParticipants(participants);
      setGuestReady(self?.ready ?? false);
      setPendingSuggestions(suggestions.filter(({ status }) => status === "pending").map(({ id, title, submittedBy, service }) => ({ id, title, submittedBy, service })));
      setApprovedSuggestions(suggestions.filter(({ status }) => status === "approved").map(({ id, title, submittedBy, service }) => ({ id, title, submittedBy, service })));
      setQueueVotes(snapshotVotes);
      setVotedTrackIds(Object.entries(snapshot.votes)
        .filter(([, clientIds]) => clientIds.includes(activeEventClientId))
        .map(([trackId]) => Number(trackId))
        .filter(Number.isSafeInteger));
      setDuplicateVoted(snapshot.votes["2"]?.includes(activeEventClientId) ?? false);
      setLiveActivity(snapshot.activity.map(({ text }) => text));
      setHandoffReceipt(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeEventClientId, activeEventToken, activeLiveSnapshot]);

  const bootstrapDurableRoom = useCallback(async (settings?: {
    locked?: boolean;
    hostApproval?: boolean;
    guestCanContribute?: boolean;
    guestExpiresAtMs?: number | null;
    expiryPolicy?: ShareExpiry;
  }, credentialsOverride?: RoomCredentials): Promise<boolean> => {
    const credentials = credentialsOverride ?? hostRoomCredentials;
    if (!credentials || sharedGuestCapability) return false;
    try {
      const requestedExpiry = settings?.guestExpiresAtMs === undefined
        ? credentials.expiryPolicy === "Never"
          ? null
          : credentials.guestExpiresAtMs === null || credentials.guestExpiresAtMs <= Date.now()
            ? guestExpiryAt(credentials.expiryPolicy)
            : credentials.guestExpiresAtMs
        : settings.guestExpiresAtMs;
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: credentials.roomId,
          hostToken: credentials.hostToken,
          guestToken: credentials.guestToken,
          expectedRevision: credentials.revision,
          guestCanContribute: settings?.guestCanContribute ?? guestCanSuggest,
          locked: settings?.locked ?? roomLocked,
          hostApproval: settings?.hostApproval ?? hostApproval,
          guestExpiresAtMs: requestedExpiry,
        }),
      });
      if (!response.ok) throw new Error("room bootstrap failed");
      const result = await response.json() as { revision?: number; guestExpiresAtMs?: number | null };
      if (!Number.isSafeInteger(result.revision)) throw new Error("room revision missing");
      const updatedCredentials: RoomCredentials = {
        ...credentials,
        revision: Number(result.revision),
        guestExpiresAtMs: result.guestExpiresAtMs === undefined ? credentials.guestExpiresAtMs : result.guestExpiresAtMs,
        expiryPolicy: settings?.expiryPolicy ?? credentials.expiryPolicy,
      };
      setRoomCredentials((current) => ({ ...current, [credentialKey]: updatedCredentials }));
      setRealtimeStatus("connected");
      return true;
    } catch {
      setRealtimeStatus("local");
      return false;
    }
  }, [credentialKey, guestCanSuggest, hostApproval, hostRoomCredentials, roomLocked, sharedGuestCapability]);

  const resetGuestCapability = () => {
    if (!hostRoomCredentials) return;
    const rotated = { ...hostRoomCredentials, guestToken: `guest-${crypto.randomUUID()}-${crypto.randomUUID()}` };
    void bootstrapDurableRoom(undefined, rotated).then((saved) => {
      notify(saved
        ? "Guest capability rotated. Previously copied room links can no longer contribute."
        : "Couldn’t rotate the guest capability. The existing link is still active.");
    });
  };

  const saveHostApproval = (next: boolean) => {
    void bootstrapDurableRoom({ hostApproval: next }).then((saved) => {
      if (saved) setHostApproval(next);
      else notify("Host approval wasn’t changed because the room could not be saved.");
    });
  };

  const saveRoomLock = (next: boolean) => {
    void bootstrapDurableRoom({ locked: next }).then((saved) => {
      if (saved) {
        setRoomLocked(next);
        notify(next ? "Room locked. Existing contributions stay visible." : "Room reopened for suggestions.");
      } else {
        notify("The room lock wasn’t changed because the room could not be saved.");
      }
    });
  };

  const saveGuestExpiry = (choice: ShareExpiry) => {
    void bootstrapDurableRoom({
      guestExpiresAtMs: guestExpiryAt(choice),
      expiryPolicy: choice,
    }).then((saved) => {
      notify(saved ? `Guest capability now expires ${choice === "Never" ? "only when reset" : `after ${choice}`}.` : "Guest expiry wasn’t changed because the room could not be saved.");
    });
  };

  const publishLiveEvent = useCallback(async (
    type: LiveRoomEventType,
    payload: LiveRoomEventPayload,
    actorName = liveActor,
    capabilityOverride?: { roomId: string; token: string; clientId?: string },
  ) => {
    const roomId = capabilityOverride?.roomId ?? activeRoomId;
    const token = capabilityOverride?.token ?? activeEventToken;
    const clientId = capabilityOverride?.clientId ?? activeEventClientId;
    if (!token) {
      setRealtimeStatus("local");
      return false;
    }
    const eventId = `event-${crypto.randomUUID()}`;
    const body = JSON.stringify({ eventId, clientId, actorName, type, payload });
    let failureMessage = "That room action could not be synced.";
    for (const delayMs of [0, 350, 1_000]) {
      if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
        });
        if (response.ok) {
          const result = await response.json() as { snapshot?: LiveRoomSnapshot };
          if (result.snapshot) {
            hydrateLiveSnapshot(roomId, result.snapshot);
          }
          setRealtimeStatus("connected");
          return true;
        }
        const problem = await response.json().catch(() => null) as { error?: string } | null;
        failureMessage = problem?.error || failureMessage;
        if (response.status === 401 || response.status === 403 || response.status === 409 || response.status === 429) break;
      } catch {
        // Retry the exact same event ID so the server can safely deduplicate it.
      }
    }
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/events?after=0`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("room snapshot unavailable");
      const result = await response.json() as { snapshot?: LiveRoomSnapshot; events?: StoredLiveRoomEvent[] };
      if (!result.snapshot) throw new Error("room snapshot missing");
      const restored = (result.events ?? []).reduce(
        (snapshot, event) => reduceLiveRoomEvent(snapshot, event),
        result.snapshot,
      );
      hydrateLiveSnapshot(roomId, restored, true);
      setRealtimeStatus("connected");
    } catch {
      setRealtimeStatus("local");
    }
    setToast(failureMessage);
    window.setTimeout(() => setToast(null), 3_200);
    return false;
  }, [activeEventClientId, activeEventToken, activeRoomId, hydrateLiveSnapshot, liveActor]);

  const joinDurableParticipant = useCallback(async (
    roomId: string,
    capabilityToken: string,
    capabilityRole: LiveRoomRole,
    nickname: string,
    preferredService: MusicPreference,
  ): Promise<DurableParticipantSession> => {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${capabilityToken}` },
      body: JSON.stringify({
        nickname,
        preferredService,
        joinNonce: participantJoinNonce(roomId, capabilityRole),
      }),
    });
    const result = await response.json() as {
      error?: string;
      participant?: {
        id?: string;
        nickname?: string;
        role?: "host" | "editor" | "viewer";
        capabilityRole?: LiveRoomRole;
        preferredService?: MusicPreference;
      };
      sessionToken?: string;
      expiresAtMs?: number;
      room?: { guestCanContribute?: boolean; locked?: boolean; hostApproval?: boolean };
    };
    if (!response.ok || !result.participant?.id || !result.participant.nickname || !result.participant.role ||
      !result.sessionToken || !Number.isSafeInteger(result.expiresAtMs)) {
      throw new Error(result.error || "Participant session could not be established");
    }
    const session: DurableParticipantSession = {
      roomId,
      participantId: result.participant.id,
      nickname: result.participant.nickname,
      capabilityRole: result.participant.capabilityRole === "host" ? "host" : "guest",
      participantRole: result.participant.role,
      token: result.sessionToken,
      expiresAtMs: Number(result.expiresAtMs),
    };
    setParticipantSession(session);
    window.sessionStorage.setItem(participantIdentityKey(roomId, capabilityRole), JSON.stringify({
      nickname: session.nickname,
      preferredService: result.participant.preferredService ?? preferredService,
    }));
    if (typeof result.room?.guestCanContribute === "boolean") setServerGuestCanContribute(result.room.guestCanContribute);
    if (typeof result.room?.locked === "boolean") setRoomLocked(result.room.locked);
    if (typeof result.room?.hostApproval === "boolean") setHostApproval(result.room.hostApproval);
    return session;
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  };

  const goTo = (destination: View) => {
    setView(destination);
    setSelectedPlaylist(null);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  };

  const openMobileNavigation = () => {
    setMobileNavOpen(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("#primary-sidebar button")?.focus());
  };

  const closeMobileNavigation = () => {
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mobileMenuRef.current?.focus());
  };

  const enterLiveRoom = (role: LiveRoomRole) => {
    setLiveRoomRole(role);
    setLiveRoomActive(true);
    setRealtimeStatus("connecting");
    setListeningMode("speaker");
    if (role === "host") setHostLensService(speakerService);
    setModal(null);
    if (role === "guest") {
      setLiveActivity((current) => [`${guestName || "Guest"} joined with ${guestService === "apple" ? "Apple Music" : guestService === "spotify" ? "Spotify" : "no default service"}`, ...current]);
    }
    const actor = role === "host" ? "Mason" : guestName || "Guest";
    const service = role === "host" ? speakerService : guestService;
    const connectParticipant = async (roomId: string, capabilityToken: string) => {
      try {
        const session = await joinDurableParticipant(roomId, capabilityToken, role, actor, service);
        await publishLiveEvent("participant_joined", { role, service }, actor, {
          roomId,
          token: session.token,
          clientId: session.participantId,
        });
      } catch {
        setRealtimeStatus("local");
        notify("Secure room identity could not be established. This session is staying local.");
      }
    };
    if (hostRoomCredentials && !sharedGuestCapability) {
      void bootstrapDurableRoom().then((saved) => {
        if (saved) void connectParticipant(
          hostRoomCredentials.roomId,
          role === "host" ? hostRoomCredentials.hostToken : hostRoomCredentials.guestToken,
        );
        else notify("Durable room sync is unavailable. This session is staying local.");
      });
    } else if (activeRoomToken) {
      void connectParticipant(activeRoomId, activeRoomToken);
    } else {
      setRealtimeStatus("local");
    }
  };

  const leaveLiveRoom = () => {
    if (activeParticipantSession) void publishLiveEvent("participant_left", {});
    setLiveRoomActive(false);
    setHandoffReceipt(null);
    setGuestReady(false);
    window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  };

  const advanceLiveTrack = () => {
    const nextIndex = (nowTrackIndex + 1) % liveQueueTracks.length;
    setNowTrackIndex(nextIndex);
    setLiveRoomPhase("idle");
    setStartedAtMs(null);
    setElapsedSeconds(0);
    setHandoffReceipt(null);
    setReactionCount(0);
    setLiveActivity((current) => ["Mason advanced the shared speaker queue", ...current]);
    void publishLiveEvent("track_advanced", { trackIndex: nextIndex }, "Mason");
  };

  const addLiveSuggestion = () => {
    const title = liveComposer.trim();
    if (!title || !canLiveContribute) return;
    const suggestion = { id: `suggestion-${crypto.randomUUID()}`, title, submittedBy: liveActor, service: liveSource } satisfies PendingSuggestion;
    if (liveRoomRole === "host" || !hostApproval) {
      setApprovedSuggestions((current) => [...current, suggestion]);
      setLiveActivity((current) => [`${liveActor} added ${title} to the next round`, ...current]);
      notify("Pick added to the next round.");
      if (liveRoomRole === "host") {
        void publishLiveEvent("suggestion_approved", { suggestionId: suggestion.id, title, submittedBy: liveActor, service: liveSource });
      } else {
        void publishLiveEvent("suggestion_staged", { suggestionId: suggestion.id, title, service: liveSource });
      }
    } else {
      setPendingSuggestions((current) => [suggestion, ...current]);
      setLiveActivity((current) => [`${liveActor} suggested ${title}`, ...current]);
      notify("Suggestion added to the host approval lane.");
      void publishLiveEvent("suggestion_staged", { suggestionId: suggestion.id, title, service: liveSource });
    }
    setLiveComposer("");
  };

  const coSignDreams = () => {
    if (!canLiveContribute) return;
    setDuplicateVoted((voted) => !voted);
    setQueueVotes((current) => ({ ...current, 2: Math.max(0, (current[2] ?? 0) + (duplicateVoted ? -1 : 1)) }));
    setLiveActivity((current) => [`${liveActor} ${duplicateVoted ? "removed a co-sign from" : "co-signed"} Dreams`, ...current]);
    notify(duplicateVoted ? "Vote removed." : "Vote joined. Your fair-queue turn is still open.");
    void publishLiveEvent("vote_changed", { trackId: 2, delta: duplicateVoted ? -1 : 1 });
  };

  const toggleLiveQueueVote = (trackId: number) => {
    if (!canLiveContribute) return;
    const voted = votedTrackIds.includes(trackId);
    setVotedTrackIds((current) => voted ? current.filter((id) => id !== trackId) : [...current, trackId]);
    setQueueVotes((current) => ({ ...current, [trackId]: Math.max(0, (current[trackId] ?? 0) + (voted ? -1 : 1)) }));
    setLiveActivity((current) => [`${liveActor} ${voted ? "removed a vote from" : "voted for"} the shared queue`, ...current]);
    void publishLiveEvent("vote_changed", { trackId, delta: voted ? -1 : 1 });
  };

  const approveLiveSuggestion = (id: string) => {
    const suggestion = pendingSuggestions.find((item) => item.id === id);
    if (!suggestion || liveRoomRole !== "host") return;
    setPendingSuggestions((current) => current.filter((item) => item.id !== id));
    setApprovedSuggestions((current) => [...current, suggestion]);
    setLiveActivity((current) => [`Mason approved ${suggestion.title} for the next round`, ...current]);
    notify("Suggestion approved and added to the next round.");
    void publishLiveEvent("suggestion_approved", { suggestionId: suggestion.id, title: suggestion.title, submittedBy: suggestion.submittedBy, service: suggestion.service }, "Mason");
  };

  const rejectLiveSuggestion = (id: string) => {
    const suggestion = pendingSuggestions.find((item) => item.id === id);
    if (!suggestion || liveRoomRole !== "host") return;
    setPendingSuggestions((current) => current.filter((item) => item.id !== id));
    setLiveActivity((current) => [`Mason passed on ${suggestion.title}`, ...current]);
    notify("Suggestion removed from the approval lane.");
    void publishLiveEvent("suggestion_rejected", { suggestionId: suggestion.id, title: suggestion.title }, "Mason");
  };

  const changeSpeakerService = (service: "spotify" | "apple") => {
    if (service === speakerService) return;
    setSpeakerService(service);
    setLiveRoomPhase("idle");
    setStartedAtMs(null);
    setElapsedSeconds(0);
    setHandoffReceipt(null);
    setLiveActivity((current) => [`Mason switched speaker duty to ${service === "spotify" ? "Spotify" : "Apple Music"}; a new handoff is required`, ...current]);
    void publishLiveEvent("speaker_service_changed", { service }, "Mason");
  };

  const changeGuestService = (service: "spotify" | "apple") => {
    if (service === guestService) return;
    setGuestService(service);
    setHandoffReceipt(null);
    if (liveRoomRole === "guest") {
      void publishLiveEvent("participant_service_changed", { service });
    }
  };

  const addLiveReaction = (reaction: string) => {
    if (!canLiveContribute) return;
    setReactionCount((count) => count + 1);
    void publishLiveEvent("reaction_added", { trackId: currentLiveTrack.id, reaction });
  };

  const openModal = (name: ModalName) => {
    if (!modal && document.activeElement instanceof HTMLElement) setModalOpener(document.activeElement);
    if (name === "create-jam") {
      setCreateStep(1);
    }
    if (name === "import") setImportStep(1);
    if (name === "guest-preview") {
      setQuickAddMode(false);
      setHostPreviewMode(true);
      setGuestStep(1);
      setGuestSearch("");
    }
    if (name === "sync" || name === "publish") {
      setSyncStep(name === "publish" && finishPreviewed ? 3 : 1);
      setSyncProgress(0);
    }
    if (name === "match") setMatchReturnTarget(null);
    setModal(name);
  };

  const openQuickAdd = () => {
    setQuickAddMode(true);
    setHostPreviewMode(false);
    setQuickAddStartedEmpty(selectedJam?.tracks === 0);
    setGuestName("Mason");
    setGuestSearch("");
    setGuestStep(2);
    setModal("guest-preview");
  };

  const closeModal = useCallback(() => {
    setModal(null);
    window.requestAnimationFrame(() => {
      modalOpener?.focus();
      setModalOpener(null);
    });
  }, [modalOpener]);

  const toggleTrack = (id: number) => {
    setSelectedTrackIds((current) =>
      current.includes(id) ? current.filter((trackId) => trackId !== id) : [...current, id],
    );
  };

  const updateSelectedRoom = (patch: Partial<Jam>) => {
    if (!selectedJam) return;
    const updatedRoom = { ...selectedJam, ...patch };
    setSelectedJam(updatedRoom);
    setJams((current) => current.map((room) => room.id === updatedRoom.id ? updatedRoom : room));
  };

  const updateSelectedRoomTracks = (trackCount: number, updateMessage: string) => {
    updateSelectedRoom({ tracks: trackCount, updated: updateMessage });
  };

  const advanceFairRotation = () => {
    const nextContributor = fairQueueEntries[0]?.item.contributorId;
    if (!nextContributor) return;
    updateSelectedRoom({ lastServedContributor: nextContributor, updated: `${nextContributor}'s turn advanced just now` });
    notify(`Rotation advanced after ${nextContributor}. The next contributor now leads the queue.`);
  };

  const moveHostTrackEarlier = (trackId: number) => {
    const defaultOrder = tracks.slice(1, 8).map((track) => track.id);
    setHostQueueOrders((current) => {
      const order = [...(current[selectedRoomId] ?? defaultOrder)];
      const index = order.indexOf(trackId);
      if (index <= 0) return current;
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
      return { ...current, [selectedRoomId]: order };
    });
    notify("Track moved one position earlier in the host order.");
  };

  const createJam = () => {
    const newJam: Jam = {
      id: Date.now(),
      name: jamName || "Untitled Room",
      tracks: 0,
      members: ["Mason"],
      status: "live",
      updated: "Created just now",
      permission: "Owner",
      access: jamPermission.replace("add songs", "suggest"),
      fairQueue,
      template: roomTemplate,
    };
    setRoomCredentials((current) => ({ ...current, [roomCredentialKey(newJam)]: createRoomCredentials() }));
    setSharedGuestCapability(null);
    setServerGuestCanContribute(null);
    setJams((current) => [newJam, ...current]);
    setSelectedJam(newJam);
    setCreateStep(3);
  };

  const startSync = () => {
    setSyncStep(2);
    setSyncProgress(18);
    window.setTimeout(() => setSyncProgress(52), 350);
    window.setTimeout(() => setSyncProgress(81), 720);
    window.setTimeout(() => {
      setSyncProgress(100);
      setSyncStep(3);
      if (modal === "publish") updateFinishState({ previewed: true });
    }, 1150);
  };

  const applyImport = () => {
    setImportStep(4);
    window.setTimeout(() => {
      const imported: Playlist = {
        id: Date.now(),
        name: "Discoveries · July",
        description: "Imported from Spotify and matched across both platforms.",
        tracks: 18,
        duration: "1 hr 9 min",
        platform: "both",
        collaborators: 0,
        updated: "Just now",
        sync: "live",
        art: "art-d",
      };
      setPlaylists((current) => [imported, ...current]);
      closeModal();
      notify("18 tracks matched and prepared for destination review.");
    }, 1200);
  };

  const copyShareLink = async () => {
    try {
      if (!hostRoomCredentials) throw new Error("Room credentials unavailable");
      const saved = await bootstrapDurableRoom();
      if (!saved) throw new Error("Room capability could not be saved");
      const slug = roomSlug(selectedJam?.name ?? "Friday Night Room");
      const roomName = selectedJam?.name ?? "Friday Night Room";
      const trackCount = selectedJam?.tracks ?? 24;
      const access = selectedJam?.access ?? "Anyone with the link can suggest";
      const queueMode = selectedJam?.fairQueue === false ? "0" : "1";
      await navigator.clipboard.writeText(`${window.location.origin}/?room=${slug}&rid=${encodeURIComponent(hostRoomCredentials.roomId)}&name=${encodeURIComponent(roomName)}&tracks=${trackCount}&access=${encodeURIComponent(access)}&fair=${queueMode}&guest=1#cap=${encodeURIComponent(hostRoomCredentials.guestToken)}`);
      updateLaunchState({ roomShared: true });
      notify("Room link copied to your clipboard.");
    } catch {
      notify("Couldn’t copy the link. Select it and copy manually.");
    }
  };

  const setSetting = (key: keyof typeof settingsState) => {
    setSettingsState((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    window.localStorage.setItem(roomCredentialStorageKey, JSON.stringify(roomCredentials));
  }, [roomCredentials]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const updateLayout = () => setIsMobileLayout(media.matches);
    const frame = window.requestAnimationFrame(updateLayout);
    media.addEventListener("change", updateLayout);
    return () => {
      window.cancelAnimationFrame(frame);
      media.removeEventListener("change", updateLayout);
    };
  }, []);

  useEffect(() => {
    const manageMobileNavigation = (event: KeyboardEvent) => {
      if (!mobileNavOpen || !isMobileLayout) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        window.requestAnimationFrame(() => mobileMenuRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const sidebar = document.getElementById("primary-sidebar");
      const focusable = sidebar ? Array.from(sidebar.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')).filter((element) => element.getClientRects().length > 0) : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", manageMobileNavigation);
    return () => window.removeEventListener("keydown", manageMobileNavigation);
  }, [isMobileLayout, mobileNavOpen]);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("room") && parameters.get("guest") === "1") {
      const timer = window.setTimeout(() => {
        const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const slug = parameters.get("room") ?? "friday-night-room";
        const linkedRoomId = parameters.get("rid")?.trim();
        const fragmentGuestToken = fragment.get("cap")?.trim();
        const capabilityStorageKey = linkedRoomId ? `unijam.guest-capability.${linkedRoomId}` : "";
        const linkedGuestToken = fragmentGuestToken || (capabilityStorageKey ? window.sessionStorage.getItem(capabilityStorageKey)?.trim() : undefined);
        if (linkedRoomId?.startsWith("room-") && linkedGuestToken?.startsWith("guest-")) {
          setSharedGuestCapability({ roomId: linkedRoomId, guestToken: linkedGuestToken });
          window.sessionStorage.setItem(capabilityStorageKey, linkedGuestToken);
          try {
            const identity = JSON.parse(window.sessionStorage.getItem(participantIdentityKey(linkedRoomId, "guest")) ?? "null") as {
              nickname?: string;
              preferredService?: MusicPreference;
            } | null;
            if (identity?.nickname?.trim()) setGuestName(identity.nickname.trim());
            if (identity?.preferredService === "spotify" || identity?.preferredService === "apple" || identity?.preferredService === "ask") {
              setGuestService(identity.preferredService);
            }
          } catch {
            // Corrupt tab-local identity metadata is replaced after the next secure join.
          }
          if (fragmentGuestToken) {
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
          }
        }
        setServerGuestCanContribute(null);
        const linkedName = parameters.get("name")?.trim() || slug.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
        const linkedTracks = Math.max(0, Number.parseInt(parameters.get("tracks") ?? "0", 10) || 0);
        const linkedAccess = parameters.get("access")?.trim() || "Anyone with the link can suggest";
        const linkedFairQueue = parameters.get("fair") !== "0";
        const knownRoom = initialJams.find((room) => roomSlug(room.name) === slug);
        setSelectedJam(knownRoom ?? {
          id: -1,
          name: linkedName,
          tracks: linkedTracks,
          members: ["Host"],
          status: "live",
          updated: "Shared demo room",
          permission: "Editor",
          access: linkedAccess,
          fairQueue: linkedFairQueue,
          template: "Shared room",
        });
        setQuickAddMode(false);
        setHostPreviewMode(false);
        setGuestStep(1);
        setGuestSearch("");
        setModal("guest-preview");
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (liveRoomPhase !== "started" || startedAtMs === null) return;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - startedAtMs) / 1000));
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [liveRoomPhase, startedAtMs]);

  useEffect(() => {
    roomEventCursorsRef.current[activeRoomId] = 0;
  }, [activeEventClientId, activeEventToken, activeRoomId]);

  useEffect(() => {
    if (!liveRoomActive) return;
    const frame = window.requestAnimationFrame(() => document.getElementById("live-main")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [liveRoomActive]);

  useEffect(() => {
    if (!liveRoomActive) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (!activeEventToken) {
        setRealtimeStatus(activeRoomToken ? "connecting" : "local");
        return;
      }
      const after = roomEventCursorsRef.current[activeRoomId] ?? 0;
      if (after === 0) setRealtimeStatus("connecting");
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}/events?after=${after}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${activeEventToken}` },
        });
        if (!response.ok) {
          if (response.status === 401 && activeRoomToken) {
            try {
              await joinDurableParticipant(activeRoomId, activeRoomToken, liveRoomRole, liveActor, liveSource);
              if (!cancelled) {
                setRealtimeStatus("connecting");
                timer = window.setTimeout(poll, 1_500);
              }
              return;
            } catch {
              // The capability may have expired or been rotated; use the normal reconnect state below.
            }
          }
          throw new Error("room event log unavailable");
        }
        const body = await response.json() as {
          events?: StoredLiveRoomEvent[];
          cursor?: number;
          hasMore?: boolean;
          snapshot?: LiveRoomSnapshot;
          activeParticipantIds?: string[];
          role?: LiveRoomRole;
          room?: { guestCanContribute?: boolean; locked?: boolean; hostApproval?: boolean };
        };
        if (cancelled) return;
        if (body.snapshot) {
          const projected = (body.events ?? []).reduce(
            (snapshot, event) => reduceLiveRoomEvent(snapshot, event),
            body.snapshot,
          );
          hydrateLiveSnapshot(activeRoomId, projected);
        } else {
          for (const event of body.events ?? []) applyRemoteLiveEvent(event);
        }
        if (typeof body.cursor === "number") {
          roomEventCursorsRef.current[activeRoomId] = Math.max(body.cursor, body.snapshot?.sequence ?? 0);
        }
        if (Array.isArray(body.activeParticipantIds)) {
          setActiveParticipantIdsByRoom((current) => ({ ...current, [activeRoomId]: body.activeParticipantIds ?? [] }));
        }
        if (body.role === "guest" && body.room) {
          if (typeof body.room.guestCanContribute === "boolean") setServerGuestCanContribute(body.room.guestCanContribute);
          if (typeof body.room.locked === "boolean") setRoomLocked(body.room.locked);
          if (typeof body.room.hostApproval === "boolean") setHostApproval(body.room.hostApproval);
        }
        setRealtimeStatus("connected");
        timer = window.setTimeout(poll, body.hasMore ? 50 : 1_500);
      } catch {
        if (cancelled) return;
        setRealtimeStatus("local");
        timer = window.setTimeout(poll, 5_000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeEventToken, activeRoomId, activeRoomToken, applyRemoteLiveEvent, hydrateLiveSnapshot, joinDurableParticipant, liveActor, liveRoomActive, liveRoomRole, liveSource]);

  const renderHome = () => (
    <div className="home-view page-enter">
      <section className="home-intro">
        <div className="intro-copy">
          <span className="eyebrow">FRIDAY NIGHT ROOM · 9 PEOPLE</span>
          <h1>
            One room.
            <br />
            Every music app.
          </h1>
          <p>Send one link. Friends add songs without an account. Preview destination updates when the room is ready.</p>
          <div className="hero-actions">
            <button type="button" className="button button-primary" onClick={() => openModal("create-jam")}>
              <Plus size={17} />
              Create a room
            </button>
            <button type="button" className="button button-outline" onClick={() => openModal("guest-preview")}>
              <Eye size={17} />
              Try the guest link
            </button>
          </div>
          <div className="friction-proof"><UserRoundCheck size={15} /><span>No guest login</span><i /><ClipboardPaste size={15} /><span>Any song link works</span></div>
        </div>

        <div className="accounts-stack" aria-label="Publish destinations">
          <div className="destination-heading"><span className="eyebrow">PUBLISH DESTINATIONS</span><small>Connect only when the room is ready</small></div>
          <button type="button" className="account-row" onClick={() => openModal("account")}>
            <span className="service-mark spotify-mark large">≋</span>
            <span>
              <strong>Spotify</strong>
              <small>Ready for 4 additions</small>
            </span>
            <span className="connected-label">
              Demo destination <span className="connected-dot" />
            </span>
            <ChevronRight size={16} className="account-chevron" />
          </button>
          <button type="button" className="account-row" onClick={() => openModal("account")}>
            <span className="service-mark apple-mark large">
              <Apple size={18} strokeWidth={2.2} />
            </span>
            <span>
              <strong>Apple Music</strong>
              <small>{matchResolved ? "Ready for 4 additions" : "3 ready · 1 match hold"}</small>
            </span>
            <span className="connected-label">
              Demo destination <span className="connected-dot" />
            </span>
            <ChevronRight size={16} className="account-chevron" />
          </button>
        </div>
      </section>

      <section className="home-grid">
        <article className="featured-jam">
          <div className="jam-information">
            <div className="jam-topline">
              <GripVertical size={18} />
              <span className="live-label">
                <span /> Collecting now
              </span>
            </div>
            <h2>Friday Night Room</h2>
            <div className="jam-meta">
              <span>
                <Music2 size={17} /> 24 suggestions
              </span>
              <span>
                <Users size={17} /> 9 contributors
              </span>
              <span className="live-sync">
                <span /> Fair queue on
              </span>
            </div>
            <div className="collaborators">
              <div>
                <Avatar name="Mason" tone="gold" size="lg" />
                <span>Mason</span>
              </div>
              <div>
                <Avatar name="Alex" tone="sage" size="lg" />
                <span>Alex</span>
              </div>
              <div>
                <Avatar name="Maya" tone="coral" size="lg" />
                <span>Maya</span>
              </div>
              <button type="button" className="invite-avatar" onClick={() => openModal("share")} aria-label="Invite contributors">
                <UserPlus size={18} />
              </button>
            </div>
            <div className="jam-player room-progress">
              <span className="room-progress-icon"><Timer size={20} /></span>
              <div className="room-progress-copy">
                <div><strong>9 of 12 invitees joined</strong><span>Median first add: 42 sec</span></div>
                <span className="room-progress-track"><i /></span>
              </div>
              <button type="button" className="button button-quiet compact-room-button" onClick={() => { setSelectedJam(initialJams[0]); goTo("jams"); }} aria-label="Open room">
                Open room <ArrowRight size={15} />
              </button>
            </div>
          </div>
          <button
            type="button"
            className="album-mosaic"
            onClick={() => {
              setSelectedJam(initialJams[0]);
              goTo("jams");
            }}
            aria-label="Open Friday Night Room"
          >
            <span className="mosaic-overlay">
              Open room <ArrowRight size={16} />
            </span>
          </button>
        </article>

        <div className="home-stats">
          <article className="stat-card sync-health-card">
            <header>
              <span>Invite conversion</span>
              <button type="button" className="text-icon-button" onClick={() => openModal("share")} aria-label="View invites">
                <UserRoundCheck size={16} />
              </button>
            </header>
            <div className="health-content">
              <span className="health-ring">
                75%
              </span>
              <div>
                <strong>9 people joined</strong>
                <small>12 invite opens · 0 login drop-offs</small>
              </div>
            </div>
          </article>

          <button type="button" className="stat-card library-stat" onClick={() => openModal("guest-preview")}>
            <header>
              <span>Time to first add</span>
              <ArrowRight size={16} />
            </header>
            <div>
              <span className="stat-icon">
                <Timer size={19} />
              </span>
              <strong>42</strong>
              <span>seconds</span>
            </div>
            <small>3× faster without account creation</small>
          </button>

          <article className="stat-card activity-card">
            <header>
              <span>Recent activity</span>
              <button type="button" className="text-link" onClick={() => goTo("activity")}>
                View all
              </button>
            </header>
            <button type="button" className="mini-activity" onClick={() => { setSelectedJam(initialJams[0]); goTo("jams"); }}>
              <Avatar name="Maya" tone="coral" size="sm" />
              <span>
                <strong>Maya</strong> added Pink + White
              </span>
              <small>now</small>
            </button>
            <button type="button" className="mini-activity" onClick={() => { setSelectedJam(initialJams[0]); goTo("jams"); }}>
              <Avatar name="Alex" tone="sage" size="sm" />
              <span>
                <strong>Alex</strong> added Dreams
              </span>
              <small>4m</small>
            </button>
          </article>
        </div>
      </section>

      <section className="insight-strip">
        <span className="insight-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <strong>{finishPreviewed ? "The finish preview is ready to share." : matchResolved ? "Four songs are ready for the finish." : "Three songs are ready everywhere. One has an Apple hold."}</strong>
          <span>{finishPreviewed ? "Review the destination results and the group shareback before connecting live accounts." : matchResolved ? "Every destination match is confirmed; the add-only preview is clean." : "Spotify can take four while Apple Music safely holds the unresolved match."}</span>
        </div>
        <button type="button" className="button button-quiet" onClick={() => openModal("publish")}>
          {finishPreviewed ? "View finish recap" : "Review safe finish"} <ArrowRight size={16} />
        </button>
      </section>

      <section className="impact-board">
        <header><div><span className="eyebrow">FRICTION REMOVED</span><h3>Why this room is working</h3></div><button type="button" className="text-link" onClick={() => openModal("guest-preview")}>See the guest experience <ArrowRight size={14} /></button></header>
        <div className="impact-grid">
          <article><span className="impact-check"><Check size={15} /></span><div><strong>No account wall</strong><small>Guests joined with a nickname only.</small></div><b>0 drop-offs</b></article>
          <article><span className="impact-check"><Check size={15} /></span><div><strong>Any link works</strong><small>Spotify, Apple Music, or plain search.</small></div><b>3 sources</b></article>
          <article><span className="impact-check"><Check size={15} /></span><div><strong>No queue hijacking</strong><small>Fair rotation balances every contributor.</small></div><b>2 moved</b></article>
          <article><span className="impact-check"><Check size={15} /></span><div><strong>No mystery sync</strong><small>{matchResolved ? "Every destination match is confirmed." : "Three are ready; one is visibly held for review."}</small></div><b>{matchResolved ? "4 ready" : "1 held"}</b></article>
        </div>
      </section>
    </div>
  );

  const renderLibrary = () => (
    <div className="page-view page-enter">
      <header className="page-heading">
        <div>
          <span className="eyebrow">24 SUGGESTIONS · 9 PEOPLE · THREE LINK TYPES</span>
          <h1>Song inbox</h1>
          <p>Every contribution lands here first—matched, deduplicated, and ready for the host to approve.</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="button button-outline" onClick={() => openModal("guest-preview")}>
            <Eye size={17} /> Preview guest link
          </button>
          <button type="button" className="button button-primary" onClick={() => openModal("publish")}>
            <Send size={17} /> {finishPreviewed ? "View recap" : `Finish ${finishReadyCount} ready`}
          </button>
        </div>
      </header>

      <section className="library-overview">
        <article>
          <span className="overview-icon unified"><Users size={18} /></span>
          <div><strong>9</strong><span>Contributors</span></div>
          <small>No accounts required</small>
        </article>
        <article>
          <span className="overview-icon spotify-mark">≋</span>
          <div><strong>7</strong><span>Spotify links</span></div>
          <small>Converted to canonical tracks</small>
        </article>
        <article>
          <span className="overview-icon apple-mark"><Apple size={18} /></span>
          <div><strong>11</strong><span>Apple Music links</span></div>
          <small>Converted to canonical tracks</small>
        </article>
        <button type="button" className="needs-attention" onClick={() => setLibraryFilter("review")}>
          <span className="overview-icon warning"><AlertTriangle size={18} /></span>
          <div><strong>{hostDecisionCount}</strong><span>Need host input</span></div>
          <small>Version or explicit rule</small>
        </button>
      </section>

      <section className="content-panel library-panel">
        <div className="panel-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              value={librarySearch}
              onChange={(event) => setLibrarySearch(event.target.value)}
              placeholder="Search suggestions, people, or artists"
              aria-label="Search song inbox"
            />
            {librarySearch && (
              <button type="button" onClick={() => setLibrarySearch("")} aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </div>
          <div className="filter-tabs" aria-label="Song inbox filter">
            {[
              ["all", "All"],
              ["both", "Ready"],
              ["spotify", "Spotify"],
              ["apple", "Apple"],
              ["review", "Needs review"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={libraryFilter === id}
                className={libraryFilter === id ? "active" : ""}
                onClick={() => setLibraryFilter(id as typeof libraryFilter)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="icon-button panel-menu" aria-label="Library view options">
            <SlidersHorizontal size={18} />
          </button>
        </div>

        {selectedTrackIds.length > 0 && (
          <div className="selection-bar">
            <span>{selectedTrackIds.length} selected</span>
            <button type="button" onClick={() => notify("Selected tracks added to Friday Night Room.")}>
              <Plus size={15} /> Add to playlist
            </button>
            <button type="button" onClick={() => notify("Matching refreshed for selected tracks.")}>
              <RefreshCw size={15} /> Rematch
            </button>
            <button type="button" onClick={() => setSelectedTrackIds([])}>
              Clear
            </button>
          </div>
        )}

        <span className="mobile-scroll-hint" id="song-inbox-scroll-hint">Swipe sideways to compare source, match, and duration.</span>
        <div className="track-table-wrap" role="region" aria-label="Scrollable song inbox" aria-describedby="song-inbox-scroll-hint" tabIndex={0}>
          <table className="track-table">
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <input
                    type="checkbox"
                    aria-label="Select visible tracks"
                    checked={filteredTracks.length > 0 && filteredTracks.every((track) => selectedTrackIds.includes(track.id))}
                    onChange={() =>
                      setSelectedTrackIds(
                        filteredTracks.every((track) => selectedTrackIds.includes(track.id))
                          ? []
                          : filteredTracks.map((track) => track.id),
                      )
                    }
                  />
                </th>
                <th>Track</th>
                <th>Album</th>
                <th>Source</th>
                <th>Match</th>
                <th>Time</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filteredTracks.map((track) => {
                const effectiveState: SyncState = track.id === 3 && matchResolved ? "synced" : track.state;
                const effectivePlatform: Platform = track.id === 3 && matchResolved ? "both" : track.platform;
                return (
                <tr key={track.id} className={effectiveState !== "synced" ? "needs-review-row" : ""}>
                  <td className="checkbox-cell">
                    <input
                      type="checkbox"
                      aria-label={"Select " + track.title}
                      checked={selectedTrackIds.includes(track.id)}
                      onChange={() => toggleTrack(track.id)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="track-title-cell"
                      onClick={() => {
                        notify("Opening “" + track.title + "” in your preferred music app.");
                      }}
                    >
                      <TrackArt art={track.art} />
                      <span>
                        <strong>
                          {track.title}
                          {track.explicit && <small className="explicit-mark">E</small>}
                        </strong>
                        <small>{track.artist}</small>
                      </span>
                    </button>
                  </td>
                  <td className="muted-cell">{track.album}</td>
                  <td><PlatformBadge platform={effectivePlatform} /></td>
                  <td>
                    <button
                      type="button"
                      className={"confidence " + effectiveState}
                      onClick={() => effectiveState !== "synced" && openModal("match")}
                    >
                      {effectiveState === "unavailable" ? (
                        <><AlertTriangle size={14} /> Unavailable</>
                      ) : (
                        <><span>{track.confidence}%</span>{effectiveState === "review" ? " Review" : " match"}</>
                      )}
                    </button>
                  </td>
                  <td className="muted-cell">{track.duration}</td>
                  <td>
                    <button type="button" className="icon-button clean" aria-label={"More options for " + track.title}>
                      <MoreHorizontal size={18} />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredTracks.length === 0 && (
          <div className="empty-state">
            <Search size={28} />
            <h3>No tracks found</h3>
            <p>Try another title, artist, album, or source.</p>
            <button type="button" className="button button-outline" onClick={() => { setLibrarySearch(""); setLibraryFilter("all"); }}>
              Clear filters
            </button>
          </div>
        )}
        <footer className="panel-footer">
            <span>Showing {filteredTracks.length} of 24 suggestions</span>
          <button type="button" onClick={() => notify("More tracks loaded.")}>Load more <ChevronDown size={15} /></button>
        </footer>
      </section>
    </div>
  );

  const renderPlaylistDetail = (playlist: Playlist) => (
    <div className="page-view page-enter detail-view">
      <button type="button" className="back-link" onClick={() => setSelectedPlaylist(null)}>
        <ArrowLeft size={16} /> All playlists
      </button>
      <section className="playlist-hero">
        <div className={"playlist-cover-large " + playlist.art}>
          <span className="cover-platform"><PlatformMark platform={playlist.platform} /></span>
        </div>
        <div className="playlist-hero-copy">
          <div className="detail-kicker">
            <SyncBadge state={playlist.sync} />
            <span>Updated {playlist.updated.toLowerCase()}</span>
          </div>
          <h1>{playlist.name}</h1>
          <p>{playlist.description}</p>
          <div className="detail-meta">
            <span>{playlist.tracks} tracks</span>
            <span>{playlist.duration}</span>
            <span>{playlist.collaborators} collaborators</span>
          </div>
          <div className="detail-actions">
            <button type="button" className="button button-primary" onClick={() => notify("Opening this playlist in your preferred music app.")}>
              Open in my app <ArrowRight size={16} />
            </button>
            <button type="button" className="button button-outline" onClick={() => openModal("share")}>
              <Share2 size={17} /> Share
            </button>
            <button type="button" className="button button-outline" onClick={() => openModal("sync")}>
              <RefreshCw size={17} /> Preview sync
            </button>
            <button type="button" className="button button-quiet" onClick={() => openModal("enhance")}>
              <WandSparkles size={17} /> Enhance
            </button>
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="content-panel detail-tracks">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">SEQUENCE</span>
              <h2>Tracklist</h2>
            </div>
            <div className="compact-search"><Search size={16} /><span>Find in playlist</span></div>
          </div>
          <div className="queue-list">
            {tracks.slice(0, 7).map((track, index) => (
              <div className="queue-row" key={track.id}>
                <button type="button" className="drag-handle" aria-label={"Reorder " + track.title}><GripVertical size={16} /></button>
                <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                <TrackArt art={track.art} />
                <div className="queue-title"><strong>{track.title}</strong><span>{track.artist}</span></div>
                <PlatformMark platform={track.platform} small />
                <span className="added-by">Added by {index % 3 === 0 ? "Maya" : index % 2 === 0 ? "Alex" : "Mason"}</span>
                <span className="muted-cell">{track.duration}</span>
                <button type="button" className="icon-button clean" aria-label={"More options for " + track.title}><MoreHorizontal size={17} /></button>
              </div>
            ))}
          </div>
          <button type="button" className="add-track-row" onClick={() => openModal("enhance")}>
            <Plus size={17} /> Add songs or get suggestions
          </button>
        </section>

        <aside className="detail-sidebar">
          <section className="side-card">
            <div className="side-card-heading"><h3>Sync status</h3><RefreshCw size={16} /></div>
            <div className="big-sync-status"><CheckCircle2 size={24} /><div><strong>No staged differences</strong><span>Demo snapshot · 8:42 PM</span></div></div>
            <div className="sync-comparison">
              <span><span className="service-mark spotify-mark">≋</span> 24 tracks</span>
              <span className="sync-arrow">↔</span>
              <span><span className="service-mark apple-mark"><Apple size={12} /></span> 24 tracks</span>
            </div>
            <button type="button" className="full-text-button" onClick={() => openModal("sync")}>View sync details <ArrowRight size={15} /></button>
          </section>
          <section className="side-card">
            <div className="side-card-heading"><h3>Collaborators</h3><button type="button" onClick={() => openModal("share")}><UserPlus size={16} /></button></div>
            {["Mason", "Maya", "Alex"].map((name, index) => (
              <div className="person-row" key={name}>
                <Avatar name={name} tone={index === 0 ? "gold" : index === 1 ? "coral" : "sage"} size="sm" />
                <div><strong>{name}</strong><span>{index === 0 ? "Owner" : "Can edit"}</span></div>
                <span className="presence-dot" />
              </div>
            ))}
          </section>
          <section className="side-card history-card">
            <div className="side-card-heading"><h3>Recent history</h3><History size={16} /></div>
            <div className="history-item"><span /><div><strong>Maya added Pink + White</strong><small>Just now</small></div></div>
            <div className="history-item"><span /><div><strong>Alex moved Dreams to #2</strong><small>4 min ago</small></div></div>
            <button type="button" className="full-text-button" onClick={() => notify("History opened. Every change can be restored.")}>View full history <ArrowRight size={15} /></button>
          </section>
        </aside>
      </div>
    </div>
  );

  const renderPlaylists = () => {
    if (selectedPlaylist) return renderPlaylistDetail(selectedPlaylist);
    return (
      <div className="page-view page-enter">
        <header className="page-heading">
          <div>
            <span className="eyebrow">TWO DESTINATIONS · FOUR STAGED UPDATES</span>
            <h1>Destinations</h1>
            <p>The room stays canonical. Spotify and Apple Music show the updates UniJam would prepare.</p>
          </div>
          <div className="heading-actions">
            <button type="button" className="button button-outline" onClick={() => openModal("import")}>
              <Plus size={17} /> Add destination
            </button>
            <button type="button" className="button button-primary" onClick={() => openModal("publish")}>
              <Send size={17} /> Preview updates
            </button>
          </div>
        </header>

        <section className="playlist-feature-banner">
          <div className="banner-mosaic" />
          <div>
            <span className="eyebrow">SAFE BY DEFAULT</span>
            <h2>A bridge you can actually trust.</h2>
            <p>Additions are staged. Removals and reorders always require approval. A production publish would create a restore point.</p>
          </div>
          <button type="button" className="button button-light" onClick={() => openModal("publish")}>
            <ShieldCheck size={17} /> Review publish plan
          </button>
        </section>

        <div className="collection-toolbar">
          <div className="search-field compact">
            <Search size={17} /><input placeholder="Search playlists" aria-label="Search playlists" />
          </div>
          <div className="toolbar-right">
            <button type="button" className="filter-button"><ListFilter size={16} /> All playlists <ChevronDown size={15} /></button>
            <button type="button" className="icon-button"><ListMusic size={17} /></button>
          </div>
        </div>

        <section className="playlist-grid">
          {playlists.map((playlist) => (
            <button type="button" className="playlist-card" key={playlist.id} onClick={() => setSelectedPlaylist(playlist)}>
              <span className={"playlist-cover " + playlist.art}>
                <span className="cover-topline"><PlatformMark platform={playlist.platform} small /><SyncBadge state={playlist.sync} /></span>
                <span className="cover-play"><Play size={20} fill="currentColor" /></span>
              </span>
              <span className="playlist-card-copy">
                <span className="playlist-title-row"><strong>{playlist.name}</strong><MoreHorizontal size={17} /></span>
                <span className="playlist-description">{playlist.description}</span>
                <span className="playlist-card-meta">
                  <span>{playlist.tracks} tracks</span>
                  <span>{playlist.updated}</span>
                  {playlist.collaborators > 0 && <span><Users size={13} /> {playlist.collaborators}</span>}
                </span>
              </span>
            </button>
          ))}
        </section>
      </div>
    );
  };

  const renderRoomLaunchpad = (jam: Jam) => (
    <div className="page-view page-enter detail-view launchpad-view">
      <button type="button" className="back-link" onClick={() => setSelectedJam(null)}>
        <ArrowLeft size={16} /> All rooms
      </button>
      <section className="jam-room-header launchpad-header">
        <div>
          <div className="detail-kicker">
            <span className="room-status live"><span /> Ready to launch</span>
            <span>{jam.access}</span>
            <span className="fair-queue-label"><ShieldCheck size={13} /> {jam.fairQueue ? "Fair queue on" : "Host ordering"}</span>
          </div>
          <h1>{jam.name}</h1>
          <p>Your room is live, but it is still yours alone. Complete one step to give the group something worth joining.</p>
        </div>
        <button type="button" className="button button-outline" onClick={copyShareLink}><Copy size={17} /> Copy room link</button>
      </section>

      <section className="launchpad-hero">
        <div className="launchpad-progress">
          <span className="eyebrow">ROOM LAUNCHPAD</span>
          <h2>Get the first contribution in.</h2>
          <p>Rooms take off faster when guests see a clear direction and one seed song. No destination account is needed yet.</p>
          <div className="launch-progress-track"><span style={{ width: `${(launchStepCount / 3) * 100}%` }} /></div>
          <small>{launchStepCount} of 3 launch steps complete</small>
        </div>
        <div className="launch-link-card">
          <span><Link2 size={18} /></span>
          <div><small>YOUR DEMO ROOM LINK</small><strong>This site · {jam.name} guest view</strong></div>
          <button type="button" onClick={copyShareLink}>Copy</button>
        </div>
      </section>

      <section className="launchpad-grid" aria-label="Room launch checklist">
        <article className={"launch-step featured" + (seedSongAdded ? " done" : "")}>
          <span className="launch-step-number">{seedSongAdded ? <Check size={14} /> : "01"}</span>
          <div><span className="eyebrow">START HERE</span><h3>Add the seed song</h3><p>Set the tone so guests immediately understand what belongs.</p></div>
          <button type="button" className={"button " + (seedSongAdded ? "button-outline" : "button-primary")} onClick={openQuickAdd}>{seedSongAdded ? <RefreshCw size={16} /> : <Plus size={16} />} {seedSongAdded ? "Change seed song" : "Add first song"}</button>
        </article>
        <article className={"launch-step" + (roomShared ? " done" : "")}>
          <span className="launch-step-number">{roomShared ? <Check size={14} /> : "02"}</span>
          <div><span className="eyebrow">INVITE</span><h3>Bring in the group</h3><p>Guests join with a nickname—no music-service login.</p></div>
          <button type="button" className="button button-outline" onClick={() => openModal("share")}><UserPlus size={16} /> Share room</button>
        </article>
        <article className={"launch-step" + (guestPreviewed ? " done" : "")}>
          <span className="launch-step-number">{guestPreviewed ? <Check size={14} /> : "03"}</span>
          <div><span className="eyebrow">TRUST CHECK</span><h3>See what guests see</h3><p>Preview the exact join and suggestion experience before sharing.</p></div>
          <button type="button" className="button button-outline" onClick={() => openModal("guest-preview")}><Eye size={16} /> Preview guest view</button>
        </article>
      </section>

      <section className="launchpad-brief">
        <div><span className="eyebrow">THE SHARED BRIEF</span><h2>{roomBrief.direction}</h2><p>{roomBrief.occasion}</p></div>
        <div className="brief-chips"><span>{roomBrief.pickLimit}</span><span>{roomBrief.explicitRule}</span><span>{roomBrief.versionRule}</span></div>
        <button type="button" className="button button-quiet" onClick={() => openModal("brief")}><SlidersHorizontal size={16} /> Edit brief</button>
      </section>

      <div className="launchpad-destination-note"><ShieldCheck size={17} /><span><strong>Spotify and Apple Music can wait.</strong> Connect destinations only after the room has approved songs to publish.</span></div>
    </div>
  );

  const renderSeededRoom = (jam: Jam) => (
    <div className="page-view page-enter detail-view seeded-room-view">
      <button type="button" className="back-link" onClick={() => setSelectedJam(null)}><ArrowLeft size={16} /> All rooms</button>
      <section className="jam-room-header">
        <div>
          <div className="detail-kicker"><span className="room-status live"><span /> Collecting · 1 song</span><span>{jam.access}</span>{jam.fairQueue && <span className="fair-queue-label"><ShieldCheck size={13} /> Fair queue on</span>}</div>
          <h1>{jam.name}</h1>
          <p>The seed song is in. Invite the group or preview the contribution experience before you share.</p>
        </div>
        <div className="jam-room-actions"><button type="button" className="button button-outline" onClick={() => openModal("share")}><UserPlus size={17} /> Share room</button><button type="button" className="button button-outline" onClick={() => openModal("guest-preview")}><Eye size={17} /> Preview as guest</button><button type="button" className="button button-primary" onClick={() => enterLiveRoom("host")}><Volume2 size={17} /> Start live room</button></div>
      </section>

      <section className="seeded-room-status">
        <div><span className="eyebrow">ROOM ACTIVATED</span><h2>There is something to react to now.</h2><p>Pink + White establishes the direction. The next open fair-queue slot belongs to the first guest who contributes.</p></div>
        <div className="seeded-room-progress"><span className="done"><Check size={14} /> Seed song</span><i /><span className={roomShared ? "done" : ""}>{roomShared ? <Check size={14} /> : <UserPlus size={14} />} Invite</span><i /><span className={guestPreviewed ? "done" : ""}>{guestPreviewed ? <Check size={14} /> : <Eye size={14} />} Preview</span></div>
      </section>

      <section className="room-brief-strip">
        <div><span className="eyebrow">THE SHARED BRIEF</span><h2>{roomBrief.direction}</h2><p>{roomBrief.occasion}</p></div>
        <div className="brief-chips"><span>{roomBrief.pickLimit}</span><span>{roomBrief.explicitRule}</span><span>{roomBrief.versionRule}</span></div>
        <button type="button" className="button button-quiet" onClick={() => openModal("brief")}><SlidersHorizontal size={16} /> Edit</button>
      </section>

      <section className="seed-track-panel">
        <div className="section-title-row"><div><span className="eyebrow">SEED SONG</span><h2>Room direction</h2></div><button type="button" className="button button-outline" onClick={openQuickAdd}><RefreshCw size={16} /> Change seed</button></div>
        <div className="seed-track-row"><TrackArt art="art-a" large /><div><strong>Pink + White</strong><span>Frank Ocean · added by Mason</span></div><PlatformMark platform="both" /><span className="match-pill">Canonical match</span></div>
      </section>

      <section className="seeded-next-actions">
        <article><UserPlus size={20} /><div><strong>Bring in the first guest</strong><span>The room link opens the right room and asks only for a nickname.</span></div><button type="button" onClick={() => openModal("share")}>Share room <ArrowRight size={14} /></button></article>
        <article><ShieldCheck size={20} /><div><strong>Guardrails are active</strong><span>{jam.fairQueue ? "Fair rotation" : "Host ordering"} · {roomBrief.pickLimit} · host approval</span></div><button type="button" onClick={() => openModal("brief")}>Review rules <ArrowRight size={14} /></button></article>
      </section>
    </div>
  );

  const renderJamDetail = (jam: Jam) => {
    if (jam.tracks === 0) return renderRoomLaunchpad(jam);
    if (jam.tracks === 1 && jam.members.length === 1) return renderSeededRoom(jam);
    return (
    <div className="page-view page-enter detail-view">
      <button type="button" className="back-link" onClick={() => setSelectedJam(null)}>
        <ArrowLeft size={16} /> All rooms
      </button>
      <section className="jam-room-header">
        <div>
          <div className="detail-kicker">
            <span className={"room-status " + jam.status}><span /> {jam.status === "live" ? "9 contributing now" : jam.status}</span>
            <span>{jam.permission}</span>
            <span className="fair-queue-label"><ShieldCheck size={13} /> {jam.fairQueue ? "Fair queue on" : "Host ordering"}</span>
          </div>
          <h1>{jam.name}</h1>
          <p>Guests add from any music link. The room decides what belongs before anything is published.</p>
        </div>
        <div className="jam-room-actions">
          <div className="stacked-avatars">
            {jam.members.slice(0, 4).map((member, index) => <Avatar key={member} name={member} tone={["gold", "sage", "coral", "blue"][index]} size="md" />)}
          </div>
          <button type="button" className="button button-outline" onClick={() => openModal("share")}><UserPlus size={17} /> Invite</button>
          <button type="button" className="button button-outline" onClick={() => enterLiveRoom("host")}><Volume2 size={17} /> Live speaker</button>
          <button type="button" className="button button-primary" onClick={() => openModal("publish")}><Send size={17} /> {finishPreviewed ? "View recap" : "Finish room"}</button>
        </div>
      </section>

      <section className="room-value-strip">
        <article><UserRoundCheck size={17} /><div><strong>9 of 12 joined</strong><span>No account required</span></div></article>
        <article><Timer size={17} /><div><strong>42 sec</strong><span>Median first contribution</span></div></article>
        <article><CircleEllipsis size={17} /><div><strong>2 duplicates blocked</strong><span>Before they hit the queue</span></div></article>
        <article><ShieldCheck size={17} /><div><strong>{matchResolved ? "4 ready" : "3 ready · 1 held"}</strong><span>No destructive changes</span></div></article>
      </section>

      <section className="room-brief-strip">
        <div><span className="eyebrow">THE SHARED BRIEF</span><h2>{roomBrief.direction}</h2><p>{roomBrief.occasion}</p></div>
        <div className="brief-chips"><span>{roomBrief.pickLimit}</span><span>{roomBrief.explicitRule}</span><span>{roomBrief.versionRule}</span></div>
        <button type="button" className="button button-quiet" onClick={() => openModal("brief")}><SlidersHorizontal size={16} /> Edit</button>
      </section>

      <section className="now-playing-card room-top-pick">
        <TrackArt art="art-a" large />
        <div className="now-playing-copy">
          <span className="eyebrow">TOP PICK · 7 VOTES</span>
          <h2>Pink + White</h2>
          <p>Frank Ocean · Added by Maya from an Apple Music link</p>
        </div>
        <div className="top-pick-reasons">
          <span><ThumbsUp size={14} /> 7 votes</span>
          <span><Users size={14} /> 3 people love this artist</span>
          <span><CheckCircle2 size={14} /> Matched on both services</span>
        </div>
        <div className="room-controls">
          <button type="button" className="button button-light" onClick={() => notify("Opening Pink + White in your preferred music app.")}>Open in my app <ArrowRight size={15} /></button>
        </div>
      </section>

      <div className="jam-room-grid">
        <section className="content-panel queue-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">UP NEXT</span><h2>Shared queue</h2></div>
            <button type="button" className="button button-outline" onClick={openQuickAdd}><Plus size={16} /> Add a song</button>
          </div>
          <div className="queue-list">
            {fairQueueEntries.map(({ item, round }, index) => {
              const track = tracks.find((candidate) => candidate.id === Number(item.id));
              if (!track) return null;
              const tone = item.contributorId === "Alex" ? "sage" : item.contributorId === "Maya" ? "coral" : item.contributorId === "Jordan" ? "blue" : "gold";
              const voted = votedTrackIds.includes(track.id);
              return (
                <div className="queue-row room-row" key={track.id}>
                  <button type="button" className={"drag-handle" + (jam.fairQueue ? " fair-locked" : "")} aria-label={jam.fairQueue ? "Fair queue controls the position of " + track.title : "Move " + track.title + " earlier"} onClick={() => jam.fairQueue ? notify("Fair queue rotates contributors automatically. Turn it off to reorder manually.") : moveHostTrackEarlier(track.id)}>{jam.fairQueue ? <Lock size={14} /> : <GripVertical size={16} />}</button>
                  <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                  <TrackArt art={track.art} />
                  <div className="queue-title"><strong>{track.title}</strong><span>{track.artist}</span></div>
                  <PlatformMark platform={track.platform} small />
                  <div className="added-person"><Avatar name={item.contributorId} tone={tone} size="sm" /><span>{item.contributorId}{jam.fairQueue ? ` · pick ${round}` : " · host order"}</span></div>
                  <button type="button" className={"queue-vote" + (voted ? " active" : "")} aria-pressed={voted} onClick={() => {
                    if (voted) return;
                    setVotedTrackIds((current) => [...current, track.id]);
                    setQueueVotes((current) => ({ ...current, [track.id]: (current[track.id] ?? 0) + 1 }));
                    notify("Your vote for “" + track.title + "” was counted. Fair order recalculated.");
                  }}><ThumbsUp size={13} /> {queueVotes[track.id] ?? 0}</button>
                  <button type="button" className="icon-button clean" aria-label={"More options for " + track.title}><MoreHorizontal size={17} /></button>
                </div>
              );
            })}
          </div>
          {jam.fairQueue ? <div className="fair-queue-explainer"><ShieldCheck size={15} /><span><strong>Why this order?</strong> One pick per contributor each round; votes rank a person’s picks inside their turn.</span><button type="button" onClick={advanceFairRotation}>Advance after: {fairQueueEntries[0]?.item.contributorId ?? "Open"}</button></div> : <div className="fair-queue-explainer host-order"><GripVertical size={15} /><span><strong>Host ordering is on.</strong> Use each row handle to move that song one position earlier; votes remain guidance.</span><button type="button" onClick={() => setHostQueueOrders((current) => ({ ...current, [selectedRoomId]: tracks.slice(1, 8).map((track) => track.id) }))}>Reset order</button></div>}
        </section>
        <aside className="jam-chat">
          <div className="chat-heading"><div><span className="eyebrow">LIVE</span><h3>Room activity</h3></div><span className="online-label"><span /> 3 online</span></div>
          <div className="chat-feed">
            <div className="system-message">Maya joined with a nickname—no account needed</div>
            <div className="chat-message"><Avatar name="Alex" tone="sage" size="sm" /><div><span>Alex · 8:41</span><p>Dreams absolutely has to stay at #2</p></div></div>
            <div className="activity-message"><Music2 size={15} /><span>Maya pasted an Apple Music link for <strong>Pink + White</strong></span></div>
            <div className="chat-message"><Avatar name="Maya" tone="coral" size="sm" /><div><span>Maya · 8:42</span><p>Correct decision</p></div></div>
          </div>
          <div className="chat-input"><input placeholder="Say something…" aria-label="Message the room" /><button type="button" aria-label="Send message" onClick={() => notify("Message sent to the room.")}><ArrowRight size={17} /></button></div>
        </aside>
      </div>
    </div>
    );
  };

  const renderJams = () => {
    if (selectedJam) return renderJamDetail(selectedJam);
    return (
      <div className="page-view page-enter">
        <header className="page-heading">
          <div>
            <span className="eyebrow">THREE ROOMS · 15 CONTRIBUTORS</span>
            <h1>Rooms</h1>
            <p>One neutral link for the group. Accounts and destination services come later.</p>
          </div>
          <button type="button" className="button button-primary" onClick={() => openModal("create-jam")}>
            <Plus size={17} /> Create a room
          </button>
        </header>
        <section className="jams-list">
          {jams.map((jam, index) => (
            <button type="button" className="jam-list-card" key={jam.id} onClick={() => setSelectedJam(jam)}>
              <span className={"jam-number jam-tone-" + index}>{String(index + 1).padStart(2, "0")}</span>
              <span className="jam-card-main"><strong>{jam.name}</strong><span>{jam.updated}</span></span>
              <span className={"room-status " + jam.status}><span /> {jam.status === "live" ? "Live now" : jam.status === "quiet" ? "Quiet" : "Scheduled"}</span>
              <span className="jam-card-members">
                <span className="stacked-avatars">
                  {jam.members.slice(0, 3).map((member, avatarIndex) => <Avatar key={member} name={member} tone={["gold", "sage", "coral"][avatarIndex]} size="sm" />)}
                </span>
                <span>{jam.members.length} people</span>
              </span>
              <span>{jam.tracks} tracks</span>
              <ArrowRight size={18} />
            </button>
          ))}
        </section>
        <section className="cross-platform-explainer">
          <div><span className="eyebrow">HOW IT WORKS</span><h2>A room between two worlds.</h2></div>
          <div className="explainer-flow">
            <span className="explainer-service"><span className="service-mark spotify-mark large">≋</span> Spotify friends</span>
            <span className="flow-line"><span /><Link2 size={18} /><span /></span>
            <span className="explainer-core"><Music2 size={23} /> UniJam</span>
            <span className="flow-line"><span /><RefreshCw size={18} /><span /></span>
            <span className="explainer-service"><span className="service-mark apple-mark large"><Apple size={18} /></span> Apple Music friends</span>
          </div>
          <p>Everyone adds through one neutral room using search or any song link. UniJam matches and deduplicates first; the host previews approved destination updates.</p>
        </section>
      </div>
    );
  };

  const renderActivity = () => (
    <div className="page-view page-enter">
      <header className="page-heading">
        <div>
          <span className="eyebrow">EVERY CHANGE, REMEMBERED</span>
          <h1>Activity</h1>
          <p>A clear record of contributions, votes, publishes, and host decisions.</p>
        </div>
        <button type="button" className="button button-outline" onClick={() => notify("Activity log exported as CSV.")}>
          <Download size={17} /> Export history
        </button>
      </header>
      <div className="activity-layout">
        <section className="content-panel activity-timeline">
          <div className="panel-toolbar activity-toolbar">
            <div className="filter-tabs">
              {["All activity", "People", "Publishes", "Matches"].map((filter) => (
                <button key={filter} type="button" aria-pressed={activityFilter === filter} className={activityFilter === filter ? "active" : ""} onClick={() => setActivityFilter(filter)}>{filter}</button>
              ))}
            </div>
            <button type="button" className="filter-button"><Clock3 size={16} /> Last 30 days <ChevronDown size={15} /></button>
          </div>
          <div className="timeline-date"><span>Today</span><i /></div>
          {activityItems.slice(0, 3).map((item) => (
            <div className="timeline-row" key={item.id}>
              <Avatar name={item.initials} tone={item.tone} size="md" />
              <div><p><strong>{item.person}</strong> {item.action} <b>{item.subject}</b> {item.destination}</p><span>{item.time}</span></div>
              <button type="button" className="icon-button clean" aria-label="View activity"><ChevronRight size={17} /></button>
            </div>
          ))}
          <div className="timeline-date"><span>This week</span><i /></div>
          {activityItems.slice(3).map((item) => (
            <div className="timeline-row" key={item.id}>
              <Avatar name={item.initials} tone={item.tone} size="md" />
              <div><p><strong>{item.person}</strong> {item.action} <b>{item.subject}</b> {item.destination}</p><span>{item.time}</span></div>
              <button type="button" className="icon-button clean" aria-label="View activity"><ChevronRight size={17} /></button>
            </div>
          ))}
        </section>
        <aside className="activity-summary">
          <section className="side-card">
            <span className="eyebrow">THIS WEEK</span>
            <div className="summary-metric"><strong>74</strong><span>songs contributed</span></div>
            <div className="metric-bar"><span style={{ width: "82%" }} /></div>
            <small>18% more than last week</small>
          </section>
          <section className="side-card">
            <div className="side-card-heading"><h3>At a glance</h3><Sparkles size={16} /></div>
            <div className="glance-row"><span>Matches confirmed</span><strong>38</strong></div>
            <div className="glance-row"><span>Collaborator adds</span><strong>21</strong></div>
            <div className="glance-row"><span>Conflicts resolved</span><strong>3</strong></div>
            <div className="glance-row"><span>Rollbacks</span><strong>0</strong></div>
          </section>
          <section className="side-card rollback-card">
            <RotateCcw size={22} />
            <h3>Made a wrong turn?</h3>
            <p>Production rollback is planned for saved destination changes.</p>
            <button type="button" className="full-text-button" onClick={() => notify("No recent changes need restoring.")}>Browse restore points <ArrowRight size={15} /></button>
          </section>
        </aside>
      </div>
    </div>
  );

  const renderSettings = () => (
    <div className="page-view page-enter settings-view">
      <header className="page-heading">
        <div>
          <span className="eyebrow">YOUR RULES, YOUR MUSIC</span>
          <h1>Settings</h1>
          <p>Choose how rooms accept contributions, resolve versions, and publish safely.</p>
        </div>
        <span className="saved-indicator"><Check size={15} /> Changes save automatically</span>
      </header>
      <div className="settings-grid">
        <div className="settings-main">
          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><Link2 size={18} /></span><div><h2>Publish destinations</h2><p>Connect host accounts only when a room is ready to publish.</p></div></div></div>
            <div className="connection-card">
              <span className="service-mark spotify-mark large">≋</span>
              <div><strong>Spotify</strong><span>Demo catalog · no live connection</span></div>
              <span className="connection-health"><Eye size={15} /> Preview</span>
              <button type="button" className="button button-small" onClick={() => openModal("account")}>Manage</button>
            </div>
            <div className="connection-card">
              <span className="service-mark apple-mark large"><Apple size={18} /></span>
              <div><strong>Apple Music</strong><span>US demo catalog · no live connection</span></div>
              <span className="connection-health"><Eye size={15} /> Preview</span>
              <button type="button" className="button button-small" onClick={() => openModal("account")}>Manage</button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><Send size={18} /></span><div><h2>Publish behavior</h2><p>The room is canonical; destination playlists are controlled outputs.</p></div></div></div>
            <div className="setting-row"><div><strong>Stage approved additions automatically</strong><span>Prepare destination updates without publishing them until the host reviews.</span></div><Toggle checked={settingsState.autoSync} onChange={() => setSetting("autoSync")} label="Stage approved additions automatically" /></div>
            <div className="setting-row"><div><strong>Automatic deduplication</strong><span>Collapse exact duplicates while preserving useful regional versions.</span></div><Toggle checked={settingsState.dedupe} onChange={() => setSetting("dedupe")} label="Automatic deduplication" /></div>
            <div className="setting-row"><div><strong>Preview destructive changes</strong><span>Removals, reorders, and low-confidence matches can never publish silently.</span></div><span className="locked-setting"><Lock size={13} /> Always on</span></div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><SlidersHorizontal size={18} /></span><div><h2>Version preferences</h2><p>Teach the matching engine which release belongs in your library.</p></div></div></div>
            <div className="setting-row"><div><strong>Prefer trusted catalog matches</strong><span>Favor the preferred destination release when recording metadata agrees.</span></div><Toggle checked={settingsState.preferLossless} onChange={() => setSetting("preferLossless")} label="Prefer trusted catalog matches" /></div>
            <div className="setting-row"><div><strong>Exclude explicit versions</strong><span>Prefer clean releases when both are available.</span></div><Toggle checked={settingsState.excludeExplicit} onChange={() => setSetting("excludeExplicit")} label="Exclude explicit versions" /></div>
            <div className="setting-row"><div><strong>Keep regional variants</strong><span>Preserve alternate catalog versions instead of merging them.</span></div><Toggle checked={settingsState.keepRegional} onChange={() => setSetting("keepRegional")} label="Keep regional variants" /></div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><ShieldCheck size={18} /></span><div><h2>Privacy & presence</h2><p>Guest identities and room activity stay minimal by default.</p></div></div></div>
            <div className="setting-row"><div><strong>Local-first Master Library</strong><span>Keep the canonical library index on this device when available.</span></div><Toggle checked={settingsState.localFirst} onChange={() => setSetting("localFirst")} label="Local-first Master Library" /></div>
            <div className="setting-row"><div><strong>Show room presence</strong><span>Let contributors see who is actively adding and voting.</span></div><Toggle checked={settingsState.listeningPresence} onChange={() => setSetting("listeningPresence")} label="Room presence" /></div>
            <div className="setting-row"><div><strong>Activity notifications</strong><span>Notify you about conflicts and collaborator changes.</span></div><Toggle checked={settingsState.notifications} onChange={() => setSetting("notifications")} label="Activity notifications" /></div>
          </section>
        </div>

        <aside className="settings-sidebar">
          <section className="side-card account-profile">
            <Avatar name="Mason Wyatt" tone="gold" size="lg" />
            <h3>Mason Wyatt</h3><p>mason@ashlr.ai</p>
            <span className="plan-pill">UniJam Pro</span>
            <button type="button" className="full-text-button" onClick={() => notify("Profile settings opened.")}>Edit profile <ArrowRight size={15} /></button>
          </section>
          <section className="side-card">
            <div className="side-card-heading"><h3>Storage</h3><span>1.8 MB</span></div>
            <div className="storage-bar"><span style={{ width: "12%" }} /></div>
            <p className="small-copy">Only metadata, mappings, and change history are stored—never your audio.</p>
          </section>
          <section className="side-card trust-card">
            <ShieldCheck size={23} />
            <h3>Privacy, by design</h3>
            <p>Production plan: encrypt OAuth tokens, minimize retained metadata, and never use room data for training without consent.</p>
            <button type="button" className="text-link" onClick={() => notify("Privacy details opened.")}>Read our privacy promise</button>
          </section>
        </aside>
      </div>
    </div>
  );

  const renderCurrentView = () => {
    switch (view) {
      case "library": return renderLibrary();
      case "playlists": return renderPlaylists();
      case "jams": return renderJams();
      case "activity": return renderActivity();
      case "settings": return renderSettings();
      default: return renderHome();
    }
  };

  const renderCreateJamModal = () => (
    <Modal title={createStep === 3 ? "Your room is live." : "Create a room"} eyebrow={createStep < 3 ? "ONE LINK · EVERY MUSIC APP" : "READY TO SHARE"} onClose={() => closeModal()}>
      {createStep === 1 && (
        <div className="modal-body">
          <div className="step-indicator"><span className="active">1</span><i /><span>2</span><i /><span>3</span></div>
          <label className="field-label">Room name<input value={jamName} onChange={(event) => setJamName(event.target.value)} autoFocus /></label>
          <div className="field-label">
            What is the room for?
            <div className="choice-grid room-template-grid" role="radiogroup" aria-label="Room template">
              {[
                ["Road trip", "Fair rotation, offline-friendly links", RadioTower],
                ["House party", "Fast voting and explicit controls", Users],
                ["Wedding", "Guest requests with host approval", Heart],
                ["Blank room", "Start simple and choose rules later", Sparkles],
              ].map(([title, copy, Icon]) => (
                <button key={title as string} type="button" role="radio" aria-checked={roomTemplate === title} className={"choice-card room-template" + (roomTemplate === title ? " selected" : "")} onClick={() => setRoomTemplate(title as string)}>
                  <span className="choice-icon"><Icon size={19} /></span><strong>{title as string}</strong><small>{copy as string}</small>{roomTemplate === title && <CheckCircle2 size={17} />}
                </button>
              ))}
            </div>
          </div>
          <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeModal}>Cancel</button><button type="button" className="button button-primary" onClick={() => setCreateStep(2)}>Choose access <ArrowRight size={16} /></button></div>
        </div>
      )}
      {createStep === 2 && (
        <div className="modal-body">
          <div className="step-indicator"><span className="done"><Check size={13} /></span><i className="done" /><span className="active">2</span><i /><span>3</span></div>
          <label className="field-label">Who can participate?</label>
          <div className="radio-stack" role="radiogroup" aria-label="Room participation">
            {[
              ["Anyone with the link can add songs", "Guests enter a nickname—no account or music login", Globe2],
              ["Only invited people can add songs", "Everyone else opens the room as a listener", Users],
              ["View only", "You control the queue; friends can listen and react", Lock],
            ].map(([title, copy, Icon]) => (
              <button key={title as string} type="button" role="radio" aria-checked={jamPermission === title} className={"radio-card" + (jamPermission === title ? " selected" : "")} onClick={() => setJamPermission(title as string)}>
                <span className="radio-control"><span /></span><Icon size={19} /><span><strong>{title as string}</strong><small>{copy as string}</small></span>
              </button>
            ))}
          </div>
          <div className="toggle-inline"><div><strong>Fair queue</strong><span>Rotate contributors so one person cannot take over.</span></div><Toggle checked={fairQueue} onChange={() => setFairQueue((value) => !value)} label="Fair queue" /></div>
          <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => setCreateStep(1)}><ArrowLeft size={16} /> Back</button><button type="button" className="button button-primary" onClick={createJam}>Create room <ArrowRight size={16} /></button></div>
        </div>
      )}
      {createStep === 3 && (
        <div className="modal-body success-body">
          <span className="success-orbit"><Music2 size={27} /></span>
          <h3>{jamName}</h3>
          <p>Guests can join with a nickname and add songs from search, Spotify, Apple Music, or any copied link.</p>
          <div className="share-field"><Link2 size={16} /><span>This site · {jamName} guest view</span><button type="button" onClick={copyShareLink}><Copy size={16} /> Copy</button></div>
          <div className="platform-ready-row"><span><UserRoundCheck size={14} /> No guest account</span><span><ClipboardPaste size={14} /> Any song link</span><span><ShieldCheck size={14} /> {fairQueue ? "Fair queue on" : "Host ordering"}</span></div>
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={copyShareLink}><Share2 size={16} /> Share link</button><button type="button" className="button button-primary" onClick={() => { closeModal(); setView("jams"); }}>Open room <ArrowRight size={16} /></button></div>
        </div>
      )}
    </Modal>
  );

  const renderImportModal = () => (
    <Modal title="Import a playlist" eyebrow="PREVIEW BEFORE SYNC" onClose={() => closeModal()} wide={importStep === 3}>
      {importStep === 1 && (
        <div className="modal-body">
          <div className="step-indicator"><span className="active">1</span><i /><span>2</span><i /><span>3</span></div>
          <label className="field-label">Import from</label>
          <div className="choice-grid">
            <button type="button" className={"choice-card service-choice" + (importSource === "spotify" ? " selected" : "")} onClick={() => setImportSource("spotify")}><span className="service-mark spotify-mark large">≋</span><strong>Spotify</strong><small>Your playlists and liked songs</small>{importSource === "spotify" && <CheckCircle2 size={17} />}</button>
            <button type="button" className={"choice-card service-choice" + (importSource === "apple" ? " selected" : "")} onClick={() => setImportSource("apple")}><span className="service-mark apple-mark large"><Apple size={18} /></span><strong>Apple Music</strong><small>Your library playlists</small>{importSource === "apple" && <CheckCircle2 size={17} />}</button>
          </div>
          <label className="field-label">Choose a playlist<button type="button" className="select-field"><span><TrackArt art="art-d" /><span><strong>Discoveries · July</strong><small>18 tracks · Updated yesterday</small></span></span><ChevronDown size={16} /></button></label>
          <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeModal}>Cancel</button><button type="button" className="button button-primary" onClick={() => { setImportStep(2); window.setTimeout(() => setImportStep(3), 1250); }}>Match tracks <ArrowRight size={16} /></button></div>
        </div>
      )}
      {importStep === 2 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><RefreshCw size={24} /></span>
          <h3>Matching 18 tracks…</h3>
          <p>Checking ISRCs, versions, durations, and your preferences across both catalogs.</p>
          <div className="processing-list"><span className="done"><Check size={15} /> Reading playlist metadata</span><span className="active"><RefreshCw size={15} /> Comparing catalog versions</span><span><CircleEllipsis size={15} /> Preparing sync preview</span></div>
        </div>
      )}
      {importStep === 3 && (
        <div className="modal-body import-preview">
          <div className="step-indicator"><span className="done"><Check size={13} /></span><i className="done" /><span className="done"><Check size={13} /></span><i className="done" /><span className="active">3</span></div>
          <div className="preview-summary"><div><strong>18</strong><span>tracks found</span></div><div className="success"><strong>16</strong><span>exact matches</span></div><div className="warning"><strong>2</strong><span>need your review</span></div></div>
          <div className="preview-table">
            {tracks.slice(0, 5).map((track, index) => (
              <div className="preview-row" key={track.id}><TrackArt art={track.art} /><div><strong>{track.title}</strong><span>{track.artist}</span></div><PlatformMark platform={importSource} small /><ArrowRight size={14} /><PlatformMark platform={importSource === "spotify" ? "apple" : "spotify"} small /><span className={"match-pill " + (index > 2 ? "review" : "")}>{index > 2 ? "Review" : "Exact"}</span></div>
            ))}
          </div>
          <label className="destination-choice"><span><strong>Prepare a playlist on {importSource === "spotify" ? "Apple Music" : "Spotify"}</strong><small>Preview catalog matches before any provider write</small></span><Toggle checked={true} onChange={() => notify("A destination is required to preview catalog coverage.")} label="Prepare matching playlist" /></label>
          <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => setImportStep(1)}><ArrowLeft size={16} /> Back</button><button type="button" className="button button-primary" onClick={applyImport}>Prepare 18 tracks <ArrowRight size={16} /></button></div>
        </div>
      )}
      {importStep === 4 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><RefreshCw size={24} /></span>
          <h3>Building your unified playlist…</h3>
          <p>Preparing matched tracks and preserving the original order.</p>
        </div>
      )}
    </Modal>
  );

  const renderGuestPreviewModal = () => (
    <Modal
      title={guestStep === 3 ? (quickAddMode ? "Seed song added." : "Suggestion received.") : guestStep === 2 ? `Add a song to ${selectedJam?.name ?? "Friday Night Room"}` : `Join ${selectedJam?.name ?? "Friday Night Room"}`}
      eyebrow={guestStep === 3 ? (quickAddMode ? "ROOM DIRECTION SET" : "MATCHED · AWAITING ROOM APPROVAL") : guestStep === 2 ? "ANY LINK · ONE CANONICAL SONG" : "GUEST EXPERIENCE · NO ACCOUNT NEEDED"}
      onClose={() => closeModal()}
    >
      {guestStep === 1 && (
        <div className="modal-body guest-join-body">
          <div className="guest-room-mark"><QrCode size={28} /></div>
          <h3>What should we call you?</h3>
          <p>Your name and listening-app preference personalize handoffs. No email, password, Spotify login, or Apple account.</p>
          <label className="field-label guest-name-field">Your name<input value={guestName} maxLength={32} required onChange={(event) => setGuestName(event.target.value)} autoFocus /></label>
          <div className="guest-service-choice"><label>Which app should links open in?</label><div role="radiogroup" aria-label="Preferred music app"><button type="button" role="radio" aria-checked={guestService === "spotify"} className={guestService === "spotify" ? "selected spotify" : "spotify"} onClick={() => setGuestService("spotify")}><span className="service-mark spotify-mark">≋</span> Spotify</button><button type="button" role="radio" aria-checked={guestService === "apple"} className={guestService === "apple" ? "selected apple" : "apple"} onClick={() => setGuestService("apple")}><span className="service-mark apple-mark"><Apple size={12} /></span> Apple Music</button><button type="button" role="radio" aria-checked={guestService === "ask"} className={guestService === "ask" ? "selected" : ""} onClick={() => setGuestService("ask")}><CircleEllipsis size={14} /> Ask each time</button></div><small>This is only a preference—no account is connected.</small></div>
          <div className="guest-trust-row"><span><UserRoundCheck size={14} /> No music login</span><span><ShieldCheck size={14} /> Nickname visible here</span><span><Timer size={14} /> About 20 seconds</span></div>
          <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeModal}>Not now</button><button type="button" className="button button-primary" disabled={!guestName.trim()} onClick={() => enterLiveRoom("guest")}>Enter live room <ArrowRight size={16} /></button></div>
        </div>
      )}
      {guestStep === 2 && (
        <div className="modal-body guest-song-body">
          <div className="guest-welcome"><Avatar name={guestName || "Guest"} tone="blue" size="md" /><div><strong>Hi, {guestName || "Guest"}.</strong><span>What song belongs in this room?</span></div><span className="room-status live"><span /> {selectedJam?.tracks === 0 ? "1 here" : "9 here"}</span></div>
          <div className="guest-room-brief"><div><span className="eyebrow">MASON&apos;S BRIEF</span><strong>{roomBrief.direction}</strong><small>{roomBrief.occasion}</small></div><div className="brief-chips"><span>{roomBrief.pickLimit}</span><span>{roomBrief.explicitRule}</span></div></div>
          {guestCanContribute ? <>
          <div className="universal-input">
            <Search size={18} />
            <input value={guestSearch} onChange={(event) => setGuestSearch(event.target.value)} placeholder="Search a song or paste any music link" aria-label="Search a song or paste any music link" autoFocus />
            <button type="button" aria-label="Paste a song link" onClick={() => setGuestSearch("https://music.apple.com/us/album/pink-white/1146195596")}><ClipboardPaste size={17} /></button>
          </div>
          <div className="input-source-hints"><span className="service-mark spotify-mark">≋</span><span className="service-mark apple-mark"><Apple size={12} /></span><span className="plain-link-mark"><Link2 size={13} /></span><small>Spotify, Apple Music, YouTube, or plain search</small></div>
          <div className="guest-results">
            <span className="eyebrow">{guestSearch.includes("http") ? "LINK MATCHED" : quickAddMode && quickAddStartedEmpty ? "SEARCH RESULTS" : "POPULAR IN THIS ROOM"}</span>
            <button type="button" className="guest-result selected" onClick={() => { if (quickAddMode) { updateLaunchState({ seedSongAdded: true }); if (quickAddStartedEmpty) updateSelectedRoomTracks(1, "Seed song added just now"); } if (hostPreviewMode) updateLaunchState({ guestPreviewed: true }); setGuestStep(3); }}>
              <TrackArt art="art-a" large />
              <span><strong>Pink + White</strong><small>Frank Ocean · Blonde</small><em><CheckCircle2 size={12} /> Available on both destinations</em></span>
              <span className="guest-add-action"><CirclePlus size={18} /> {quickAddMode && quickAddStartedEmpty ? "Use as seed" : "Suggest"}</span>
            </button>
            {!(quickAddMode && quickAddStartedEmpty) && <button type="button" className="guest-result" onClick={() => { setGuestSearch("Dreams — Fleetwood Mac"); }}>
              <TrackArt art="art-b" large />
              <span><strong>Dreams</strong><small>Fleetwood Mac · Rumours</small><em><ThumbsUp size={12} /> Already has 6 votes</em></span>
              <span className="guest-add-action"><ThumbsUp size={18} /> Vote instead</span>
            </button>}
          </div>
          <div className="duplicate-guard"><ShieldCheck size={15} /><span>Duplicates and unavailable versions are caught before you add them.</span></div>
          </> : <div className="guest-locked-state"><span><Lock size={22} /></span><h3>{selectedJam?.access === "View only" ? "This room is view only." : "This room is invite only."}</h3><p>You can see the shared brief, but this link does not grant suggestion access. Ask the host for an editor invitation.</p><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>}
        </div>
      )}
      {guestStep === 3 && (
        <div className="modal-body guest-success-body">
          <span className="success-orbit"><Check size={27} /></span>
          <h3>{quickAddMode ? "Pink + White starts the room." : "Pink + White is waiting for the room."}</h3>
          <p>{quickAddMode ? "Your seed song gives every guest a concrete starting point. It was matched to one canonical track across both demo catalogs." : "Your suggestion was matched to one canonical song. It can collect votes now; Mason approves the final playlist before anything is published."}</p>
          <div className="guest-added-card"><TrackArt art="art-a" large /><div><strong>Pink + White</strong><span>Frank Ocean · suggested by {guestName || "Guest"}</span></div><span className="match-pill">Both services</span></div>
          <div className="submission-receipt"><span className="done"><Check size={13} /> {quickAddMode ? "Seed saved" : "Suggestion received"}</span><i /><span className="done"><Check size={13} /> Canonical match found</span><i /><span className={quickAddMode ? "done" : ""}>{quickAddMode ? <Check size={13} /> : <Clock3 size={13} />} {quickAddMode ? "Ready for guests" : "Awaiting approval"}</span></div>
          <div className="guest-impact-note"><Timer size={15} /><span>{quickAddMode ? "The launchpad now has a seed song. No destination account was needed." : "You can undo this suggestion for 10 seconds. No music-service account was connected."}</span></div>
          <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => { if (quickAddMode) { updateLaunchState({ seedSongAdded: false }); if (quickAddStartedEmpty) updateSelectedRoomTracks(0, "Room created just now"); } setGuestSearch(""); setGuestStep(2); notify(quickAddMode ? "Seed song cleared." : "Suggestion undone."); }}><RotateCcw size={16} /> Undo</button><button type="button" className="button button-primary" onClick={() => { closeModal(); if (hostPreviewMode && view !== "jams") goTo("jams"); }}>{quickAddMode || hostPreviewMode ? (selectedJam?.tracks === 0 ? "Back to launchpad" : "Back to room") : "Done"} <ArrowRight size={16} /></button></div>
        </div>
      )}
    </Modal>
  );

  const renderPublishModal = () => (
    <Modal title={syncStep === 3 ? "Safe finish preview complete." : "Preview the safe finish"} eyebrow="CONCEPT DEMO · THE ROOM IS THE SOURCE OF TRUTH" onClose={() => closeModal()} wide>
      {syncStep === 1 && (
        <div className="modal-body publish-body">
          <div className="canonical-flow">
            <div className="canonical-room"><span className="canonical-icon"><Music2 size={20} /></span><span><strong>{selectedJam?.name ?? "Friday Night Room"}</strong><small>{selectedJam?.tracks ?? 24} approved songs · canonical order</small></span></div>
            <span className="publish-arrow"><ArrowRight size={18} /></span>
            <div className="publish-destinations">
              <button type="button" className="publish-destination selected"><span className="service-mark spotify-mark">≋</span><span><strong>Spotify</strong><small>4 ready</small></span><CheckCircle2 size={16} /></button>
              <button type="button" className="publish-destination selected"><span className="service-mark apple-mark"><Apple size={12} /></span><span><strong>Apple Music</strong><small>{matchResolved ? "4 ready" : "3 ready · 1 match hold"}</small></span><CheckCircle2 size={16} /></button>
            </div>
          </div>
          <div className="publish-policy-bar"><ShieldCheck size={17} /><div><strong>Add-only publish</strong><span>No removals. No reorders. No silent changes.</span></div><button type="button" onClick={() => notify("Add-only is the safest default for shared rooms.")}>Why?</button></div>
          <div className="publish-list">
            <header><span>{matchResolved ? "4 ready for both destinations" : "Spotify 4 · Apple Music 3"}</span><small>{matchResolved ? "Every version is confirmed" : "One Apple Music version needs a choice"}</small></header>
            {tracks.slice(0, 4).map((track, index) => (
              <div className={"publish-row" + (track.state === "review" && !matchResolved ? " exception" : "")} key={track.id}><span className="publish-number">{String(index + 1).padStart(2, "0")}</span><TrackArt art={track.art} /><div><strong>{track.title}</strong><span>{track.artist} · {track.state === "review" && !matchResolved ? "Apple Music version unconfirmed" : "Added by " + ["Maya", "Alex", "Jordan", "Mason"][index]}</span></div><PlatformMark platform={track.state === "review" && matchResolved ? "both" : track.platform} small />{track.state === "review" && !matchResolved ? <button type="button" className="match-pill review" onClick={() => { setMatchReturnTarget("publish"); setModal("match"); }}>Review</button> : <span className="match-pill">Ready</span>}</div>
            ))}
          </div>
          <div className="publish-summary"><span><Plus size={14} /> {matchResolved ? "8 safe writes" : "7 safe writes"}</span><span><AlertTriangle size={14} /> {matchResolved ? "0 held" : "1 Apple hold"}</span><span><X size={14} /> 0 removals</span><span><History size={14} /> Restore point planned</span></div>
          <div className="simulation-note"><Eye size={15} /><span>This prototype simulates provider writes. No Spotify or Apple Music playlist will be changed.</span></div>
          <div className="failure-scenario-row"><div><strong>Test a recovery state</strong><span>Make Apple Music require reconnection in this simulation.</span></div><Toggle checked={appleNeedsReconnect} onChange={() => updateFinishState({ appleNeedsReconnect: !appleNeedsReconnect })} label="Simulate Apple Music reconnection" /></div>
          <div className="modal-actions split">{!matchResolved && <button type="button" className="button button-outline" onClick={() => { setMatchReturnTarget("publish"); setModal("match"); }}>Resolve Apple match</button>}<button type="button" className="button button-primary" onClick={startSync}>Simulate {matchResolved ? "8" : "7"} safe writes <Send size={16} /></button></div>
        </div>
      )}
      {syncStep === 2 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><Send size={23} /></span>
          <h3>Simulating destination writes…</h3>
          <p>Checking each destination independently. {matchResolved ? "All four confirmed songs are included." : "Spotify includes four; Apple Music safely holds the unresolved version."}</p>
          <div className="progress-track"><span style={{ width: syncProgress + "%" }} /></div>
          <span className="progress-label">{syncProgress}% complete</span>
        </div>
      )}
      {syncStep === 3 && (
        <div className="modal-body success-body">
          <span className="success-orbit"><Check size={27} /></span>
          <h3>{appleNeedsReconnect ? "Spotify simulation passed. Apple Music needs you." : matchResolved ? "Four-song destination preview." : "Spotify 4 · Apple Music 3."}</h3>
          <p>{appleNeedsReconnect ? "Nothing was removed. Reconnect Apple Music and retry only that destination; Spotify does not run twice." : matchResolved ? "Every confirmed addition passed preflight." : "Both destinations passed independently. Nights stays held only on Apple Music until its match is resolved."}</p>
          <div className="publish-success-destinations"><button type="button" onClick={() => notify("This would open the finished Spotify playlist.")}><span className="service-mark spotify-mark">≋</span><strong>Spotify</strong><small>4 ready · Preview</small></button><button type="button" className={appleNeedsReconnect ? "needs-reconnect" : ""} onClick={() => appleNeedsReconnect ? updateFinishState({ appleNeedsReconnect: false }) : notify("This would open the finished Apple Music playlist.")}><span className="service-mark apple-mark"><Apple size={12} /></span><strong>Apple Music</strong><small>{appleNeedsReconnect ? "Reconnect · Retry only Apple" : matchResolved ? "4 ready · Preview" : "3 ready · 1 held"}</small></button></div>
          <div className="completed-breakdown"><span><Check size={14} /> {appleNeedsReconnect ? "4 Spotify writes passed simulation" : `${matchResolved ? "8" : "7"} writes passed simulation`}</span><span><Check size={14} /> 0 destructive changes</span><span><AlertTriangle size={14} /> {appleNeedsReconnect ? "Apple retry pending" : matchResolved ? "0 songs held" : "1 Apple match held"}</span></div>
          {!appleNeedsReconnect && <div className="finished-shareback"><Users size={17} /><div><strong>Close the loop with the group</strong><span>Preview one recap where each person can choose Spotify or Apple Music.</span></div><button type="button" onClick={() => notify("This is the group shareback preview; no message was sent.")}>Preview shareback</button></div>}
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => { closeModal(); goTo("activity"); }}><History size={16} /> View decisions</button><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>
        </div>
      )}
    </Modal>
  );

  const renderSyncModal = () => (
    <Modal title={syncStep === 3 ? "Simulation complete." : "Destination diff simulation"} eyebrow="CONCEPT DEMO · ZERO-SURPRISE PUBLISHING" onClose={() => closeModal()} wide>
      {syncStep === 1 && (
        <div className="modal-body sync-preview-body">
          <div className="sync-direction">
            <div><span className="service-mark spotify-mark large">≋</span><span><strong>Spotify</strong><small>3 changes detected</small></span></div>
            <span className="sync-bridge"><ArrowRight size={18} /><ArrowLeft size={18} /></span>
            <div><span className="service-mark apple-mark large"><Apple size={18} /></span><span><strong>Apple Music</strong><small>1 change detected</small></span></div>
          </div>
          <div className="change-summary">
            <article><Plus size={18} /><div><strong>3 additions</strong><span>Safe to apply</span></div></article>
            <article><GripVertical size={18} /><div><strong>1 reorder</strong><span>Safe to apply</span></div></article>
            <article className="warning"><AlertTriangle size={18} /><div><strong>1 conflict</strong><span>Smart default selected</span></div></article>
          </div>
          <div className="conflict-card">
            <header><span><AlertTriangle size={16} /> Version conflict</span><small>Eventually · Tame Impala</small></header>
            <div className="version-choices">
              <button type="button" className="version-option"><PlatformMark platform="spotify" /><span><strong>Currents</strong><small>2015 · Explicit · 5:19</small></span></button>
              <span className="instead-label">prefer</span>
              <button type="button" className="version-option selected"><PlatformMark platform="apple" /><span><strong>Currents</strong><small>Preferred Apple catalog match · 5:19</small></span><CheckCircle2 size={17} /></button>
            </div>
            <p><Sparkles size={14} /> UniJam chose this catalog version because the recording identifiers and duration align.</p>
          </div>
          <div className="safety-note"><ShieldCheck size={17} /><span><strong>Nothing would be removed.</strong> A production publish would plan a restore point before writing.</span></div>
          <div className="modal-actions split"><button type="button" className="button button-outline" onClick={() => notify("Detailed simulation expanded.")}>View full simulation</button><button type="button" className="button button-primary" onClick={startSync}>Simulate 4 changes <ArrowRight size={16} /></button></div>
        </div>
      )}
      {syncStep === 2 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><RefreshCw size={24} /></span>
          <h3>Previewing both destinations…</h3>
          <p>Simulating provider results. No playlist is being changed.</p>
          <div className="progress-track"><span style={{ width: syncProgress + "%" }} /></div>
          <span className="progress-label">{syncProgress}% complete</span>
        </div>
      )}
      {syncStep === 3 && (
        <div className="modal-body success-body">
          <span className="success-orbit"><Check size={27} /></span>
          <h3>Four changes passed the preview.</h3>
          <p>No external playlist was changed. In production, each destination would report success or a retryable failure independently.</p>
          <div className="completed-breakdown"><span><Check size={14} /> 3 additions previewed</span><span><Check size={14} /> 1 reorder previewed</span><span><Check size={14} /> Preferred catalog match selected</span></div>
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => notify("A production restore-point plan would appear here.")}><History size={16} /> Preview history plan</button><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>
        </div>
      )}
    </Modal>
  );

  const renderEnhanceModal = () => (
    <Modal title="Enhance this playlist" eyebrow="TASTEFUL, NOT RANDOM" onClose={() => closeModal()} wide>
      <div className="modal-body enhance-body">
        <div className="enhance-intro"><span className="sparkle-orbit"><WandSparkles size={22} /></span><div><h3>Four songs that belong here.</h3><p>Chosen from the playlist arc, your group’s taste, and cross-catalog availability.</p></div></div>
        <div className="recommendation-list">
          {recommendations.map((track) => (
            <button type="button" className={"recommendation-row" + (recommendationIds.includes(track.id) ? " selected" : "")} key={track.id} onClick={() => setRecommendationIds((current) => current.includes(track.id) ? current.filter((id) => id !== track.id) : [...current, track.id])}>
              <span className="custom-check">{recommendationIds.includes(track.id) && <Check size={13} />}</span><TrackArt art={track.art} /><div><strong>{track.title}</strong><span>{track.artist}</span></div><small><Sparkles size={13} /> {track.reason}</small><PlatformMark platform="both" small />
            </button>
          ))}
        </div>
        <div className="enhance-control"><span><strong>More familiar</strong><small>Keep recommendations close to what’s already here</small></span><input type="range" min="0" max="100" defaultValue="62" aria-label="Recommendation familiarity" /><span className="range-end">More adventurous</span></div>
        <div className="modal-actions split"><button type="button" className="button button-outline" onClick={() => notify("Four fresh suggestions generated.")}><RefreshCw size={16} /> Regenerate</button><button type="button" className="button button-primary" onClick={() => { closeModal(); notify(recommendationIds.length + " songs added with cross-platform matches."); }}>Add {recommendationIds.length} songs <ArrowRight size={16} /></button></div>
      </div>
    </Modal>
  );

  const renderShareModal = () => (
    <Modal title="Invite people, not accounts" eyebrow="ONE LINK · ZERO APP POLITICS" onClose={() => closeModal()}>
      <div className="modal-body">
        <div className="share-visual"><span className="service-mark spotify-mark large">≋</span><span className="link-orbit"><QrCode size={21} /></span><span className="service-mark apple-mark large"><Apple size={18} /></span></div>
        <p className="center-copy">Friends join with a nickname—no UniJam or music-service account. Their nickname, suggestions, votes, and messages are visible to people in this room.</p>
        <div className="share-field"><Link2 size={16} /><span>This site · {selectedJam?.name ?? "Friday Night Room"} guest view</span><button type="button" onClick={copyShareLink}><Copy size={16} /> Copy</button></div>
        <div className="permission-summary">{guestCanContribute ? <Globe2 size={17} /> : <Lock size={17} />}<div><strong>{roomLocked ? "Room temporarily locked" : selectedJam?.access ?? "Anyone with the link can suggest"}</strong><span>{guestCanContribute ? (hostApproval ? "Mason approves staged picks" : "Approved picks join the next round") : "This link does not grant contribution access"}</span></div><span>{roomBrief.pickLimit}</span></div>
        <section className="share-safety-panel">
          <div className="share-control-heading"><div><strong>Link controls</strong><span>Change these without interrupting the room.</span></div><ShieldCheck size={17} /></div>
          <div className="share-expiry"><label>Guest capability expires</label><div>{(["24 hours", "7 days", "Never"] as ShareExpiry[]).map((choice) => <button key={choice} type="button" aria-pressed={shareExpiry === choice} className={shareExpiry === choice ? "selected" : ""} onClick={() => saveGuestExpiry(choice)}>{choice}</button>)}</div></div>
          <div className="share-toggle-row"><div><strong>Host approval</strong><span>Suggestions collect votes before joining the final playlist.</span></div><Toggle checked={hostApproval} onChange={() => saveHostApproval(!hostApproval)} label="Host approval" /></div>
          <div className="share-safety-actions"><button type="button" className={roomLocked ? "locked" : ""} aria-pressed={roomLocked} onClick={() => saveRoomLock(!roomLocked)}><Lock size={14} /> {roomLocked ? "Unlock room" : "Lock room"}</button><button type="button" onClick={resetGuestCapability}><RotateCcw size={14} /> Reset link</button></div>
        </section>
        <div className="guest-trust-row share-trust-row"><span><UserRoundCheck size={14} /> Nickname only</span><span><ClipboardPaste size={14} /> {guestCanContribute ? "Any song link" : "Viewing only"}</span><span><ShieldCheck size={14} /> {selectedJam?.fairQueue === false ? "Host ordering" : "Fair queue"}</span></div>
        <div className="invite-list"><div className="person-row"><Avatar name="Maya" tone="coral" size="sm" /><div><strong>Maya</strong><span>Apple Music · Editor</span></div><span className="presence-dot" /></div><div className="person-row"><Avatar name="Alex" tone="sage" size="sm" /><div><strong>Alex</strong><span>Spotify · Editor</span></div><span className="presence-dot" /></div></div>
        <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => notify("Invitation message ready.")}><MessageCircle size={16} /> Send message</button><button type="button" className="button button-primary" onClick={copyShareLink}><Copy size={16} /> Copy room link</button></div>
      </div>
    </Modal>
  );

  const renderMatchModal = () => (
    <Modal title="Choose the right version" eyebrow="MATCH REVIEW" onClose={() => closeModal()} wide>
      <div className="modal-body match-review-body">
        <div className="source-track">
          <span className="eyebrow">ORIGINAL ON SPOTIFY</span>
          <div><TrackArt art="art-c" large /><span><strong>Nights</strong><small>Frank Ocean · Blonde · 5:07</small></span><PlatformMark platform="spotify" /></div>
        </div>
        <p className="match-explanation"><Sparkles size={15} /> UniJam found two likely Apple Music matches. Audio version, duration, and release metadata are weighted separately.</p>
        <div className="candidate-list" role="radiogroup" aria-label="Apple Music version">
          <button type="button" role="radio" aria-checked={selectedMatchId === "studio"} className={"candidate-card" + (selectedMatchId === "studio" ? " selected" : "")} onClick={() => setSelectedMatchId("studio")}><span className="custom-radio"><span /></span><TrackArt art="art-c" large /><div><strong>Nights</strong><span>Frank Ocean · Blonde</span><small>Same ISRC · Duration +0s · Explicit</small></div><span className="candidate-score"><strong>96%</strong><small>Best match</small></span></button>
          <button type="button" role="radio" aria-checked={selectedMatchId === "live"} className={"candidate-card" + (selectedMatchId === "live" ? " selected" : "")} onClick={() => setSelectedMatchId("live")}><span className="custom-radio"><span /></span><TrackArt art="art-a" large /><div><strong>Nights</strong><span>Frank Ocean · Live at FYF</span><small>Different ISRC · Duration +42s · Live</small></div><span className="candidate-score low"><strong>61%</strong><small>Possible</small></span></button>
        </div>
        <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => { if (matchReturnTarget === "publish") setModal("publish"); else closeModal(); notify("Nights remains held. Spotify can finish while Apple Music waits."); }}>Keep it held</button><button type="button" className="button button-primary" onClick={() => { updateFinishState({ matchResolved: true }); if (matchReturnTarget === "publish") setModal("publish"); else closeModal(); notify(selectedMatchId === "studio" ? "Studio match confirmed. Four songs are now ready." : "Live version selected. Four songs are now ready."); }}>Confirm match <ArrowRight size={16} /></button></div>
      </div>
    </Modal>
  );

  const renderAccountModal = () => (
    <Modal title="Destination previews" eyebrow="CONCEPT DEMO · NO LIVE ACCOUNTS" onClose={() => closeModal()}>
      <div className="modal-body">
        <div className="account-detail-card"><span className="service-mark spotify-mark large">≋</span><div><strong>Spotify</strong><span>Example destination</span><small><Eye size={13} /> Live connection not configured</small></div><button type="button" className="button button-small" onClick={() => notify("Production setup requires approved Spotify API access.")}>Setup plan</button></div>
        <div className="account-detail-card"><span className="service-mark apple-mark large"><Apple size={18} /></span><div><strong>Apple Music</strong><span>United States demo storefront</span><small><Eye size={13} /> Live connection not configured</small></div><button type="button" className="button button-small" onClick={() => notify("Production setup requires MusicKit credentials.")}>Setup plan</button></div>
        <div className="scope-note"><ShieldCheck size={17} /><p><strong>Production security model.</strong><br />OAuth tokens would be encrypted and access limited to preparing host-approved destination updates.</p></div>
        <div className="modal-actions"><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>
      </div>
    </Modal>
  );

  const renderBriefModal = () => (
    <Modal title="Set the room direction" eyebrow="ONE SHARED BRIEF · FEWER RANDOM PICKS" onClose={() => closeModal()}>
      <div className="modal-body brief-modal-body">
        <p className="brief-modal-intro">Guests see this before they suggest a song. Keep it specific enough to guide the room without over-managing it.</p>
        <label className="field-label">Occasion<input value={roomBrief.occasion} onChange={(event) => updateRoomBrief({ occasion: event.target.value })} /></label>
        <label className="field-label">What should the music feel like?<textarea value={roomBrief.direction} onChange={(event) => updateRoomBrief({ direction: event.target.value })} rows={3} /></label>
        <div className="brief-rule-group">
          <label className="field-label">Contribution limit</label>
          <div className="brief-choice-row">
            {["2 picks each", "3 picks each", "No limit"].map((choice) => <button key={choice} type="button" aria-pressed={roomBrief.pickLimit === choice} className={roomBrief.pickLimit === choice ? "selected" : ""} onClick={() => updateRoomBrief({ pickLimit: choice })}>{choice}</button>)}
          </div>
        </div>
        <div className="brief-rule-group">
          <label className="field-label">Explicit tracks</label>
          <div className="brief-choice-row">
            {["No explicit tracks", "Explicit after 10 PM", "Explicit allowed"].map((choice) => <button key={choice} type="button" aria-pressed={roomBrief.explicitRule === choice} className={roomBrief.explicitRule === choice ? "selected" : ""} onClick={() => updateRoomBrief({ explicitRule: choice })}>{choice}</button>)}
          </div>
        </div>
        <div className="brief-rule-group">
          <label className="field-label">Version preference</label>
          <div className="brief-choice-row">
            {["Studio versions", "Any version", "Host decides"].map((choice) => <button key={choice} type="button" aria-pressed={roomBrief.versionRule === choice} className={roomBrief.versionRule === choice ? "selected" : ""} onClick={() => updateRoomBrief({ versionRule: choice })}>{choice}</button>)}
          </div>
        </div>
        <div className="scope-note"><ShieldCheck size={17} /><p><strong>A guide, not a gate.</strong><br />Suggestions that miss the brief remain visible; the host gets the final call.</p></div>
        <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeModal}>Cancel</button><button type="button" className="button button-primary" onClick={() => { closeModal(); notify("Room brief updated for every guest."); }}>Save brief <Check size={16} /></button></div>
      </div>
    </Modal>
  );

  const renderLiveRoom = () => {
    const lensService: "spotify" | "apple" = liveRoomRole === "host" ? hostLensService : guestService === "ask" ? speakerService : guestService;
    const lensLabel = lensService === "spotify" ? "Spotify" : "Apple Music";
    const liveIdentityPending = Boolean(activeRoomToken && !activeParticipantSession);
    const liveReadOnly = liveRoomRole === "guest" && !liveIdentityPending && !guestCanContribute;
    const coverageFor = (track: Track) => {
      if (track.id === 3 && lensService === "apple") return { tone: "alternate", label: "Demo: Apple alternate" };
      if (track.id === 6 && lensService === "spotify") return { tone: "hold", label: "Demo: Spotify match held" };
      return { tone: "exact", label: "Demo: exact on both" };
    };
    const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
    const normalizedComposer = liveComposer.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const isDreamsDuplicate = normalizedComposer === "dreams" || normalizedComposer === "dreams fleetwood mac" || normalizedComposer === "fleetwood mac dreams";

    return (
      <div className="live-room-shell">
        <a className="skip-link live-skip-link" href="#live-main">Skip to live room</a>
        <header className="live-room-topbar">
          <button type="button" className="live-brand" onClick={leaveLiveRoom}><Music2 size={18} /><span>UniJam</span></button>
          <div className="live-room-identity"><span className="live-pulse"><i /> LIVE ROOM DEMO</span><strong>{selectedJam?.name ?? "Friday Night Room"}</strong><small>{realtimeStatus === "connected" ? "Durable room sync on" : realtimeStatus === "connecting" ? "Connecting room event log" : "Local fallback mode"} · {approvedSuggestions.length + 4} picks ready</small></div>
          <div className="live-service-lens" aria-label="Catalog service lens"><span>Viewing as</span><button type="button" disabled={liveIdentityPending} aria-pressed={lensService === "spotify"} className={lensService === "spotify" ? "active" : ""} onClick={() => liveRoomRole === "host" ? setHostLensService("spotify") : changeGuestService("spotify")}><span className="service-mark spotify-mark">≋</span> Spotify</button><button type="button" disabled={liveIdentityPending} aria-pressed={lensService === "apple"} className={lensService === "apple" ? "active" : ""} onClick={() => liveRoomRole === "host" ? setHostLensService("apple") : changeGuestService("apple")}><span className="service-mark apple-mark"><Apple size={12} /></span> Apple</button></div>
          <button type="button" className="live-leave" onClick={leaveLiveRoom}><ArrowLeft size={15} /> {liveRoomRole === "host" ? "Back to host view" : "Leave room"}</button>
        </header>

        <div className="live-concept-note"><ShieldCheck size={14} /><span><strong>Interactive concept demo.</strong> Catalog coverage is illustrative; joined identities and room actions are durable. {realtimeStatus === "connected" ? "New room actions replay across browsers through an authoritative event log." : "Room actions are waiting for durable sync."} {speakerService === "spotify" ? "Spotify" : "Apple Music"} would supply sound on Mason&apos;s device.</span></div>
        {toast && <div className="live-toast" role="status" aria-live="polite">{toast}</div>}

        <main id="live-main" className="live-room-workspace" tabIndex={-1}>
          <section className="live-mode-bar">
            <div className="speaker-duty"><span className="speaker-orbit"><Volume2 size={20} /></span><div><span className="eyebrow">SHARED SPEAKER</span><strong>Mason is on speaker duty · {speakerService === "spotify" ? "Spotify" : "Apple Music"}</strong><small>One native app supplies the sound. Everyone else shapes the same room.</small></div></div>
            {liveRoomRole === "guest" ? <div className="listening-mode-switch"><button type="button" disabled={liveIdentityPending} aria-pressed={listeningMode === "speaker"} className={listeningMode === "speaker" ? "active" : ""} onClick={() => setListeningMode("speaker")}><Volume2 size={14} /> Shared speaker</button><button type="button" disabled={liveIdentityPending} aria-pressed={listeningMode === "native"} className={listeningMode === "native" ? "active" : ""} onClick={() => setListeningMode("native")}><Headphones size={14} /> My own app</button></div> : <div className="host-speaker-source"><span>Speaker source</span><button type="button" disabled={liveIdentityPending} onClick={() => changeSpeakerService(speakerService === "spotify" ? "apple" : "spotify")}>Switch to {speakerService === "spotify" ? "Apple Music" : "Spotify"} <RefreshCw size={13} /></button></div>}
          </section>

          <div className="live-room-grid">
            <div className="live-room-main-column">
              <section className="live-now-card">
                <div className={"live-cover " + currentLiveTrack.art}><span>{liveRoomPhase === "started" ? <Volume2 size={24} /> : <Music2 size={24} />}</span></div>
                <div className="live-now-copy"><span className="eyebrow">{liveRoomPhase === "started" ? `HOST-CONFIRMED START · ${elapsed}` : liveRoomPhase === "handoff" ? `HANDOFF REQUESTED FOR ${speakerService.toUpperCase()} · CONFIRM START` : "READY ON THE SHARED SPEAKER"}</span><h1>{currentLiveTrack.title}</h1><p>{currentLiveTrack.artist} · proposed by Maya</p><div className="live-coverage-row"><span className={coverageFor(currentLiveTrack).tone}><CheckCircle2 size={13} /> {coverageFor(currentLiveTrack).label}</span><span><Heart size={13} /> {reactionCount} reactions</span></div></div>
                <div className="live-now-actions">
                  {liveIdentityPending ? <div className="live-read-only-action"><Wifi size={15} /><span><strong>Securing your room identity</strong><small>Shared controls unlock as soon as this device joins.</small></span></div> : liveRoomRole === "host" ? <>
                    {liveRoomPhase === "idle" && <a href={serviceSearchUrl(speakerService, currentLiveTrack)} target="_blank" rel="noreferrer" onClick={() => { setLiveRoomPhase("handoff"); setLiveActivity((current) => [`Mason requested a ${speakerService === "spotify" ? "Spotify" : "Apple Music"} web handoff for ${currentLiveTrack.title}`, ...current]); void publishLiveEvent("handoff_requested", { role: "host", service: speakerService, trackId: currentLiveTrack.id }, "Mason"); }}>Search {speakerService === "spotify" ? "Spotify" : "Apple Music"} web <ExternalLink size={15} /><span className="sr-only"> (opens in a new tab)</span></a>}
                    {liveRoomPhase === "handoff" && <><button type="button" className="confirm-start" onClick={() => { const now = Date.now(); setStartedAtMs(now); setElapsedSeconds(0); setLiveRoomPhase("started"); setLiveActivity((current) => [`Mason confirmed ${currentLiveTrack.title} started`, ...current]); void publishLiveEvent("playback_confirmed", { service: speakerService, trackId: currentLiveTrack.id }, "Mason"); }}>It started <Check size={15} /></button><a className="try-web" href={serviceSearchUrl(speakerService, currentLiveTrack)} target="_blank" rel="noreferrer">Try web <ExternalLink size={14} /></a></>}
                    {liveRoomPhase === "started" && <button type="button" className="advance-track" onClick={advanceLiveTrack}>Advance room <SkipForward size={16} /></button>}
                  </> : listeningMode === "speaker" ? (liveReadOnly ? <div className="live-read-only-action"><Lock size={15} /><span><strong>Viewing only</strong><small>This link can follow the room but cannot react, vote, or suggest.</small></span></div> : <><button type="button" className={guestReady ? "ready active" : "ready"} aria-pressed={guestReady} onClick={() => { const nextReady = !guestReady; setGuestReady(nextReady); setLiveActivity((current) => [`${guestName || "Guest"} is ${nextReady ? "ready" : "not ready"} for the current track`, ...current]); void publishLiveEvent("ready_changed", { ready: nextReady, trackId: currentLiveTrack.id }); }}>{guestReady ? <Check size={15} /> : <Wifi size={15} />} {guestReady ? "Ready" : "I’m ready"}</button><div className="reaction-buttons"><button type="button" aria-label="Love this track" onClick={() => addLiveReaction("heart")}>♥</button><button type="button" aria-label="Celebrate this track" onClick={() => addLiveReaction("spark")}>✦</button><button type="button" aria-label="React to this track" onClick={() => addLiveReaction("smile")}><SmilePlus size={15} /></button></div><small>{readyCount} people ready · sound comes from Mason&apos;s speaker</small></>) : <><a href={serviceSearchUrl(lensService, currentLiveTrack)} target="_blank" rel="noreferrer" onClick={() => { setHandoffReceipt({ service: lensService, trackId: currentLiveTrack.id }); if (!liveReadOnly) { setLiveActivity((current) => [`${guestName || "Guest"} requested a ${lensLabel} web handoff for ${currentLiveTrack.title}`, ...current]); void publishLiveEvent("handoff_requested", { role: "guest", service: lensService, trackId: currentLiveTrack.id }); } }}>Search {lensLabel} web <ExternalLink size={15} /><span className="sr-only"> (opens in a new tab)</span></a>{handoffReceipt?.service === lensService && handoffReceipt.trackId === currentLiveTrack.id && <span className="handoff-receipt"><Check size={13} /> Handoff requested for {lensLabel} · playback not verified</span>}</>}
                </div>
              </section>

              <section className="live-next-panel">
                <header><div><span className="eyebrow">NOW / NEXT IS SHARED</span><h2>Up next</h2></div><span className="queue-contract"><ShieldCheck size={14} /> {selectedJam?.fairQueue === false ? "Host-curated order" : "Fair turns across contributors"}</span></header>
                <div className="live-next-list">
                  {nextLiveTracks.map((track, index) => {
                    const contributor = ["Alex", "Jordan", "Nora"][index];
                    const coverage = coverageFor(track);
                    return <article key={`${track.id}-${index}`}><span className="next-position">{String(index + 1).padStart(2, "0")}</span><TrackArt art={track.art} /><div className="next-track-copy"><strong>{track.title}</strong><span>{track.artist} · proposed by {contributor}</span></div><span className={`coverage-pill ${coverage.tone}`}>{coverage.label}</span><button type="button" disabled={!canLiveContribute} className={votedTrackIds.includes(track.id) ? "voted" : ""} aria-pressed={votedTrackIds.includes(track.id)} onClick={() => toggleLiveQueueVote(track.id)}><ThumbsUp size={13} /> {queueVotes[track.id] ?? 0}</button>{liveRoomRole === "guest" && <a href={serviceSearchUrl(lensService, track)} target="_blank" rel="noreferrer" aria-label={`Search ${track.title} in ${lensLabel}; opens in a new tab`}><ExternalLink size={14} /></a>}</article>;
                  })}
                  {approvedSuggestions.map((suggestion, index) => <article className="approved-suggestion" key={suggestion.id}><span className="next-position">{String(nextLiveTracks.length + index + 1).padStart(2, "0")}</span><span className="match-art"><Music2 size={16} /></span><div className="next-track-copy"><strong>{suggestion.title}</strong><span>proposed by {suggestion.submittedBy}</span></div><span className="coverage-pill alternate">Catalog check pending</span><span className="approved-label"><Check size={12} /> Accepted</span><span /></article>)}
                </div>
              </section>

              <section className="live-composer-panel">
                <header><div><span className="eyebrow">UNIVERSAL SONG DROP</span><h2>{liveIdentityPending ? "Joining the room" : liveReadOnly ? "Room contributions" : "Add from any app"}</h2></div><span>Service lens: {lensLabel} · demo US storefront</span></header>
                {liveIdentityPending ? <div className="guest-locked-state live-locked-state"><span><Wifi size={22} /></span><h3>Establishing a secure participant session</h3><p>Your nickname, role, and music-app preference are being bound to this room before shared controls unlock.</p></div> : liveReadOnly ? <div className="guest-locked-state live-locked-state"><span><Lock size={22} /></span><h3>Viewing-only room</h3><p>This shared link can follow now/next and use personal web searches, but it cannot react, vote, or add songs.</p></div> : <>
                  <div className="live-composer"><Search size={18} /><input value={liveComposer} onChange={(event) => setLiveComposer(event.target.value)} placeholder="Search or paste a Spotify, Apple Music, or YouTube link" aria-label="Stage a song for the live room" /><button type="button" onClick={() => setLiveComposer("Dreams — Fleetwood Mac")}>Try duplicate</button></div>
                  {liveComposer.trim() && (isDreamsDuplicate ? <div className="live-match-result duplicate"><TrackArt art="art-b" /><div><span className="eyebrow">DEMO DUPLICATE</span><strong>Dreams is already in round 1.</strong><small>Co-sign it without spending another fair-queue turn.</small></div><button type="button" aria-pressed={duplicateVoted} onClick={coSignDreams}><ThumbsUp size={15} /> {duplicateVoted ? "Remove vote" : `Join ${queueVotes[2] ?? 6} votes`}</button></div> : <div className="live-match-result"><span className="match-art"><Music2 size={20} /></span><div><span className="eyebrow">UNVERIFIED DEMO QUERY</span><strong>{liveComposer}</strong><small>A production catalog lookup would verify identity, versions, and storefront availability before approval.</small></div><button type="button" onClick={addLiveSuggestion}><Plus size={15} /> {liveRoomRole === "host" || !hostApproval ? "Add to round" : "Stage pick"}</button></div>)}
                </>}
                {pendingSuggestions.length > 0 && <div className="pending-lane"><span className="eyebrow">HOST APPROVAL · {pendingSuggestions.length}</span>{pendingSuggestions.map((suggestion) => <div key={suggestion.id}><span className="pending-dot" /><strong>{suggestion.title}</strong><span>{suggestion.submittedBy} · from {suggestion.service === "apple" ? "Apple Music" : suggestion.service === "spotify" ? "Spotify" : "plain search"}</span><small>Catalog verification pending</small>{liveRoomRole === "host" && <span className="pending-actions"><button type="button" onClick={() => approveLiveSuggestion(suggestion.id)}><Check size={12} /> Approve</button><button type="button" onClick={() => rejectLiveSuggestion(suggestion.id)}><X size={12} /> Pass</button></span>}</div>)}</div>}
              </section>
            </div>

            <aside className="live-room-rail">
              <section className="live-presence-card">
                <header><div><span className="eyebrow">ROOM PARTICIPANTS</span><h3>{presentParticipants.length} {presentParticipants.length === 1 ? "person" : "people"} here now</h3></div><span className={`presence-live ${realtimeStatus}`}><i /> {realtimeStatus === "connected" ? "Synced" : realtimeStatus === "connecting" ? "Connecting" : "Local"}</span></header>
                <div className="live-people">
                  {presentParticipants.length === 0 ? <p className="live-people-empty">Participant identities appear here as this durable room connects.</p> : presentParticipants.map((participant, index) => (
                    <div key={participant.clientId}>
                      <Avatar name={participant.name} tone={["gold", "coral", "sage", "blue"][index % 4]} size="sm" />
                      <span><strong>{participant.name}{participant.clientId === activeEventClientId ? " · You" : ""}</strong><small>{participant.service === "apple" ? "Apple Music" : participant.service === "spotify" ? "Spotify" : "Ask each time"}{participant.ready ? " · Ready" : " · Joined"}</small></span>
                      {participant.role === "host" ? <em>Host</em> : <i className="here" />}
                    </div>
                  ))}
                </div>
                <div className="playability-score demo-score"><span><strong>DEMO</strong><small>cross-catalog coverage lens</small></span><p>Example exact, alternate, and held states show the intended provider-aware experience.</p></div>
              </section>
              <section className="live-activity-card"><header><span className="eyebrow">DURABLE ROOM SIGNAL</span><h3>What just happened</h3></header><div role="log" aria-live="polite" aria-relevant="additions">{liveActivity.length === 0 ? <p><span />Waiting for the first room action<small>synced</small></p> : liveActivity.slice(0, 5).map((activity, index) => <p key={`${activity}-${index}`}><span />{activity}<small>{index === 0 ? "now" : "synced"}</small></p>)}</div></section>
              <section className="room-brief-live"><span className="eyebrow">THE BRIEF</span><h3>{roomBrief.direction}</h3><p>{roomBrief.occasion}</p><div className="brief-chips"><span>{roomBrief.pickLimit}</span><span>{roomBrief.explicitRule}</span></div></section>
            </aside>
          </div>
        </main>
      </div>
    );
  };

  if (liveRoomActive) return renderLiveRoom();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <button type="button" className={"mobile-overlay" + (mobileNavOpen ? " visible" : "")} onClick={closeMobileNavigation} aria-label="Close navigation" />
      <aside id="primary-sidebar" className={"sidebar" + (mobileNavOpen ? " open" : "")} inert={modal || (isMobileLayout && !mobileNavOpen) ? true : undefined} aria-hidden={modal || (isMobileLayout && !mobileNavOpen) ? true : undefined}>
        <button type="button" className="brand" onClick={() => goTo("home")}>
          <span className="brand-mark"><Music2 size={18} /></span>
          <span>UniJam</span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => goTo(item.id)}>
                <Icon size={19} strokeWidth={1.9} /><span>{item.label}</span>
                {item.id === "activity" && <small className="nav-count">3</small>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button type="button" className={view === "settings" ? "active" : ""} onClick={() => goTo("settings")}><Settings size={19} /><span>Settings</span></button>
          <button type="button" className="profile-button" onClick={() => goTo("settings")}>
            <Avatar name="Mason Wyatt" tone="gold" size="md" />
            <span><strong>Mason</strong><small>UniJam Pro</small></span>
            <ChevronDown size={16} />
          </button>
        </div>
      </aside>

      <main id="main-content" className="workspace" tabIndex={-1} inert={modal || (isMobileLayout && mobileNavOpen) ? true : undefined} aria-hidden={modal || (isMobileLayout && mobileNavOpen) ? true : undefined}>
        <div className="concept-banner" role="note"><Eye size={14} /><span><strong>Concept demo</strong> · Example room data. No Spotify or Apple Music account is connected; publishing actions are simulated.</span></div>
        <header className="mobile-header">
          <button type="button" className="mobile-brand" onClick={() => goTo("home")}><Music2 size={17} /><span>UniJam</span></button>
          <button ref={mobileMenuRef} type="button" className="icon-button" onClick={openMobileNavigation} aria-label="Open navigation" aria-expanded={mobileNavOpen} aria-controls="primary-sidebar"><Menu size={21} /></button>
        </header>
        {renderCurrentView()}
      </main>

      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span></div>}
      {modal === "create-jam" && renderCreateJamModal()}
      {modal === "import" && renderImportModal()}
      {modal === "sync" && renderSyncModal()}
      {modal === "enhance" && renderEnhanceModal()}
      {modal === "share" && renderShareModal()}
      {modal === "match" && renderMatchModal()}
      {modal === "account" && renderAccountModal()}
      {modal === "guest-preview" && renderGuestPreviewModal()}
      {modal === "publish" && renderPublishModal()}
      {modal === "brief" && renderBriefModal()}
    </div>
  );
}
