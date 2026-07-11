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
  Clock3,
  Copy,
  Download,
  Globe2,
  GripVertical,
  Headphones,
  Heart,
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
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  UserPlus,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type View = "home" | "library" | "playlists" | "jams" | "activity" | "settings";
type ModalName =
  | "create-jam"
  | "import"
  | "sync"
  | "enhance"
  | "share"
  | "match"
  | "account"
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
};

const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "library", label: "Library", icon: LibraryBig },
  { id: "playlists", label: "Playlists", icon: ListMusic },
  { id: "jams", label: "Jams", icon: RadioTower },
  { id: "activity", label: "Activity", icon: Activity },
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
    name: "Friday Night Jam",
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
    name: "Friday Night Jam",
    tracks: 24,
    members: ["Mason", "Alex", "Maya"],
    status: "live",
    updated: "Maya added a song just now",
    permission: "Owner",
  },
  {
    id: 2,
    name: "Beach Weekend",
    tracks: 48,
    members: ["Mason", "Luke", "Evan", "Sam"],
    status: "quiet",
    updated: "Evan reordered 3 tracks · 2h",
    permission: "Owner",
  },
  {
    id: 3,
    name: "Studio Picks",
    tracks: 31,
    members: ["Mason", "Nora"],
    status: "scheduled",
    updated: "Listening session Sunday at 8:00 PM",
    permission: "Editor",
  },
];

const activityItems = [
  {
    id: 1,
    person: "Maya",
    initials: "MY",
    action: "added",
    subject: "Pink + White",
    destination: "Friday Night Jam",
    time: "Just now",
    tone: "coral",
  },
  {
    id: 2,
    person: "Alex",
    initials: "AL",
    action: "added",
    subject: "Dreams",
    destination: "Friday Night Jam",
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
      {state === "live" ? "Live sync" : state === "review" ? "Needs review" : "Paused"}
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
  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={"modal-card" + (wide ? " modal-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
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
  const [isPlaying, setIsPlaying] = useState(false);
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

  const filteredTracks = useMemo(() => {
    const query = librarySearch.trim().toLowerCase();
    return tracks.filter((track) => {
      const matchesSearch =
        !query ||
        track.title.toLowerCase().includes(query) ||
        track.artist.toLowerCase().includes(query) ||
        track.album.toLowerCase().includes(query);
      const matchesFilter =
        libraryFilter === "all" ||
        (libraryFilter === "review" && track.state !== "synced") ||
        track.platform === libraryFilter ||
        (libraryFilter !== "review" && track.platform === "both");
      return matchesSearch && matchesFilter;
    });
  }, [libraryFilter, librarySearch]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  };

  const goTo = (destination: View) => {
    setView(destination);
    setSelectedPlaylist(null);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openModal = (name: ModalName) => {
    if (name === "create-jam") setCreateStep(1);
    if (name === "import") setImportStep(1);
    if (name === "sync") {
      setSyncStep(1);
      setSyncProgress(0);
    }
    setModal(name);
  };

  const closeModal = () => setModal(null);

  const toggleTrack = (id: number) => {
    setSelectedTrackIds((current) =>
      current.includes(id) ? current.filter((trackId) => trackId !== id) : [...current, id],
    );
  };

  const createJam = () => {
    const newJam: Jam = {
      id: Date.now(),
      name: jamName || "Untitled Jam",
      tracks: 0,
      members: ["Mason"],
      status: "live",
      updated: "Created just now",
      permission: "Owner",
    };
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
      notify("18 tracks matched and synced to both platforms.");
    }, 1200);
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText("https://unijam.music/jam/friday-night");
      notify("Jam link copied to your clipboard.");
    } catch {
      notify("Jam link ready to share.");
    }
  };

  const setSetting = (key: keyof typeof settingsState) => {
    setSettingsState((current) => ({ ...current, [key]: !current[key] }));
  };

  const renderHome = () => (
    <div className="home-view page-enter">
      <section className="home-intro">
        <div className="intro-copy">
          <span className="eyebrow">SATURDAY, JUL 11</span>
          <h1>
            Your music,
            <br />
            finally together.
          </h1>
          <p>Spotify and Apple Music stay in tune, automatically.</p>
          <div className="hero-actions">
            <button type="button" className="button button-primary" onClick={() => openModal("create-jam")}>
              <Plus size={17} />
              Start a jam
            </button>
            <button type="button" className="button button-outline" onClick={() => openModal("import")}>
              <Upload size={17} />
              Import playlist
            </button>
          </div>
        </div>

        <div className="accounts-stack" aria-label="Connected music accounts">
          <button type="button" className="account-row" onClick={() => openModal("account")}>
            <span className="service-mark spotify-mark large">≋</span>
            <span>
              <strong>Spotify</strong>
              <small>@masonwyatt</small>
            </span>
            <span className="connected-label">
              Connected <span className="connected-dot" />
            </span>
            <ChevronRight size={16} className="account-chevron" />
          </button>
          <button type="button" className="account-row" onClick={() => openModal("account")}>
            <span className="service-mark apple-mark large">
              <Apple size={18} strokeWidth={2.2} />
            </span>
            <span>
              <strong>Apple Music</strong>
              <small>US storefront</small>
            </span>
            <span className="connected-label">
              Connected <span className="connected-dot" />
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
                <span /> Live now
              </span>
            </div>
            <h2>Friday Night Jam</h2>
            <div className="jam-meta">
              <span>
                <Music2 size={17} /> 24 tracks
              </span>
              <span>
                <Users size={17} /> 3 collaborators
              </span>
              <span className="live-sync">
                <span /> Live sync
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
              <button type="button" className="invite-avatar" onClick={() => openModal("share")} aria-label="Invite collaborator">
                <UserPlus size={18} />
              </button>
            </div>
            <div className="jam-player">
              <button
                type="button"
                className="play-button"
                aria-label={isPlaying ? "Pause Friday Night Jam" : "Play Friday Night Jam"}
                onClick={() => setIsPlaying((playing) => !playing)}
              >
                {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              </button>
              <div className="wave-wrap">
                <div className={"waveform" + (isPlaying ? " playing" : "")} aria-hidden="true">
                  {Array.from({ length: 42 }).map((_, index) => (
                    <span key={index} style={{ height: 8 + ((index * 13) % 27) + "px" }} />
                  ))}
                </div>
                <div className="player-times">
                  <span>1:24</span>
                  <span>3:58</span>
                </div>
              </div>
              <button type="button" className="icon-button clean" onClick={() => { setSelectedJam(initialJams[0]); goTo("jams"); }} aria-label="Open jam queue">
                <ListMusic size={20} />
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
            aria-label="Open Friday Night Jam"
          >
            <span className="mosaic-overlay">
              Open jam <ArrowRight size={16} />
            </span>
          </button>
        </article>

        <div className="home-stats">
          <article className="stat-card sync-health-card">
            <header>
              <span>Sync health</span>
              <button type="button" className="text-icon-button" onClick={() => openModal("sync")} aria-label="View sync status">
                <RefreshCw size={16} />
              </button>
            </header>
            <div className="health-content">
              <span className="health-ring">
                <Check size={22} />
              </span>
              <div>
                <strong>All caught up</strong>
                <small>Last checked 2 min ago</small>
              </div>
            </div>
          </article>

          <button type="button" className="stat-card library-stat" onClick={() => goTo("library")}>
            <header>
              <span>Unified library</span>
              <ArrowRight size={16} />
            </header>
            <div>
              <span className="stat-icon">
                <Music2 size={19} />
              </span>
              <strong>2,481</strong>
              <span>songs</span>
            </div>
            <small>+38 this week</small>
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
          <strong>Your libraries are 84% in sync.</strong>
          <span>UniJam found 7 version upgrades and 3 tracks that need a quick look.</span>
        </div>
        <button type="button" className="button button-quiet" onClick={() => openModal("sync")}>
          Review changes <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );

  const renderLibrary = () => (
    <div className="page-view page-enter">
      <header className="page-heading">
        <div>
          <span className="eyebrow">2,481 TRACKS · TWO SOURCES</span>
          <h1>Your library</h1>
          <p>Every song you love, with its source and match history intact.</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="button button-outline" onClick={() => openModal("import")}>
            <Upload size={17} /> Import
          </button>
          <button type="button" className="button button-primary" onClick={() => openModal("sync")}>
            <RefreshCw size={17} /> Sync now
          </button>
        </div>
      </header>

      <section className="library-overview">
        <article>
          <span className="overview-icon spotify-mark">≋</span>
          <div><strong>1,927</strong><span>Spotify tracks</span></div>
          <small>98% matched</small>
        </article>
        <article>
          <span className="overview-icon apple-mark"><Apple size={18} /></span>
          <div><strong>2,114</strong><span>Apple Music tracks</span></div>
          <small>97% matched</small>
        </article>
        <article>
          <span className="overview-icon unified"><Link2 size={18} /></span>
          <div><strong>1,560</strong><span>Shared matches</span></div>
          <small>84% overlap</small>
        </article>
        <article className="needs-attention" onClick={() => setLibraryFilter("review")}>
          <span className="overview-icon warning"><AlertTriangle size={18} /></span>
          <div><strong>10</strong><span>Need attention</span></div>
          <small>Review matches</small>
        </article>
      </section>

      <section className="content-panel library-panel">
        <div className="panel-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              value={librarySearch}
              onChange={(event) => setLibrarySearch(event.target.value)}
              placeholder="Search songs, artists, or albums"
              aria-label="Search library"
            />
            {librarySearch && (
              <button type="button" onClick={() => setLibrarySearch("")} aria-label="Clear search">
                <X size={15} />
              </button>
            )}
          </div>
          <div className="filter-tabs" aria-label="Library source">
            {[
              ["all", "All"],
              ["both", "Matched"],
              ["spotify", "Spotify"],
              ["apple", "Apple"],
              ["review", "Needs review"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
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
            <button type="button" onClick={() => notify("Selected tracks added to Friday Night Jam.")}>
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

        <div className="track-table-wrap">
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
              {filteredTracks.map((track) => (
                <tr key={track.id} className={track.state !== "synced" ? "needs-review-row" : ""}>
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
                        setIsPlaying(true);
                        notify("Now playing “" + track.title + "”.");
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
                  <td><PlatformBadge platform={track.platform} /></td>
                  <td>
                    <button
                      type="button"
                      className={"confidence " + track.state}
                      onClick={() => track.state !== "synced" && openModal("match")}
                    >
                      {track.state === "unavailable" ? (
                        <><AlertTriangle size={14} /> Unavailable</>
                      ) : (
                        <><span>{track.confidence}%</span>{track.state === "review" ? " Review" : " match"}</>
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
              ))}
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
          <span>Showing {filteredTracks.length} of 2,481 tracks</span>
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
            <button type="button" className="button button-primary" onClick={() => setIsPlaying((playing) => !playing)}>
              {isPlaying ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
              {isPlaying ? "Pause" : "Play"}
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
            <div className="big-sync-status"><CheckCircle2 size={24} /><div><strong>Perfectly in sync</strong><span>Spotify ↔ Apple Music</span></div></div>
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
            <span className="eyebrow">12 PLAYLISTS · 8 LIVE SYNCS</span>
            <h1>Playlists</h1>
            <p>Curate once. Keep every version, platform, and collaborator together.</p>
          </div>
          <div className="heading-actions">
            <button type="button" className="button button-outline" onClick={() => openModal("import")}>
              <Upload size={17} /> Import
            </button>
            <button type="button" className="button button-primary" onClick={() => openModal("create-jam")}>
              <Plus size={17} /> New playlist
            </button>
          </div>
        </header>

        <section className="playlist-feature-banner">
          <div className="banner-mosaic" />
          <div>
            <span className="eyebrow">SMART CURATION</span>
            <h2>Make a good playlist great.</h2>
            <p>UniJam reads the arc, energy, and taste of your group—then suggests songs that belong.</p>
          </div>
          <button type="button" className="button button-light" onClick={() => openModal("enhance")}>
            <Sparkles size={17} /> Try playlist enhance
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

  const renderJamDetail = (jam: Jam) => (
    <div className="page-view page-enter detail-view">
      <button type="button" className="back-link" onClick={() => setSelectedJam(null)}>
        <ArrowLeft size={16} /> All jams
      </button>
      <section className="jam-room-header">
        <div>
          <div className="detail-kicker">
            <span className={"room-status " + jam.status}><span /> {jam.status === "live" ? "3 listening now" : jam.status}</span>
            <span>{jam.permission}</span>
          </div>
          <h1>{jam.name}</h1>
          <p>A shared queue that works whether your friends use Spotify or Apple Music.</p>
        </div>
        <div className="jam-room-actions">
          <div className="stacked-avatars">
            {jam.members.slice(0, 4).map((member, index) => <Avatar key={member} name={member} tone={["gold", "sage", "coral", "blue"][index]} size="md" />)}
          </div>
          <button type="button" className="button button-outline" onClick={() => openModal("share")}><UserPlus size={17} /> Invite</button>
          <button type="button" className="button button-primary" onClick={() => notify("Listening session started for everyone in the jam.")}><Headphones size={17} /> Listen together</button>
        </div>
      </section>

      <section className="now-playing-card">
        <TrackArt art="art-a" large />
        <div className="now-playing-copy">
          <span className="eyebrow">NOW PLAYING FOR THE ROOM</span>
          <h2>Pink + White</h2>
          <p>Frank Ocean · Blonde</p>
        </div>
        <div className="now-wave">
          <div className={"waveform room-wave" + (isPlaying ? " playing" : "")}>
            {Array.from({ length: 46 }).map((_, index) => <span key={index} style={{ height: 8 + ((index * 17) % 31) + "px" }} />)}
          </div>
          <div className="player-times"><span>1:24</span><span>3:04</span></div>
        </div>
        <div className="room-controls">
          <button type="button" className="play-button light" onClick={() => setIsPlaying((value) => !value)}>
            {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <button type="button" className="icon-button dark-button" aria-label="Like track"><Heart size={19} /></button>
        </div>
      </section>

      <div className="jam-room-grid">
        <section className="content-panel queue-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">UP NEXT</span><h2>Shared queue</h2></div>
            <button type="button" className="button button-outline" onClick={() => openModal("enhance")}><Plus size={16} /> Add a song</button>
          </div>
          <div className="queue-list">
            {tracks.slice(1, 8).map((track, index) => (
              <div className="queue-row room-row" key={track.id}>
                <button type="button" className="drag-handle" aria-label={"Reorder " + track.title}><GripVertical size={16} /></button>
                <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                <TrackArt art={track.art} />
                <div className="queue-title"><strong>{track.title}</strong><span>{track.artist}</span></div>
                <PlatformMark platform={track.platform} small />
                <div className="added-person"><Avatar name={index % 2 === 0 ? "Alex" : "Maya"} tone={index % 2 === 0 ? "sage" : "coral"} size="sm" /><span>{index % 2 === 0 ? "Alex" : "Maya"}</span></div>
                <span className="muted-cell">{track.duration}</span>
                <button type="button" className="icon-button clean" aria-label={"More options for " + track.title}><MoreHorizontal size={17} /></button>
              </div>
            ))}
          </div>
        </section>
        <aside className="jam-chat">
          <div className="chat-heading"><div><span className="eyebrow">LIVE</span><h3>Room activity</h3></div><span className="online-label"><span /> 3 online</span></div>
          <div className="chat-feed">
            <div className="system-message">Maya joined from Apple Music</div>
            <div className="chat-message"><Avatar name="Alex" tone="sage" size="sm" /><div><span>Alex · 8:41</span><p>Dreams absolutely has to stay at #2</p></div></div>
            <div className="activity-message"><Music2 size={15} /><span>Maya added <strong>Pink + White</strong></span></div>
            <div className="chat-message"><Avatar name="Maya" tone="coral" size="sm" /><div><span>Maya · 8:42</span><p>Correct decision</p></div></div>
          </div>
          <div className="chat-input"><input placeholder="Say something…" aria-label="Message the jam" /><button type="button" aria-label="Send message" onClick={() => notify("Message sent to the jam.")}><ArrowRight size={17} /></button></div>
        </aside>
      </div>
    </div>
  );

  const renderJams = () => {
    if (selectedJam) return renderJamDetail(selectedJam);
    return (
      <div className="page-view page-enter">
        <header className="page-heading">
          <div>
            <span className="eyebrow">THREE SHARED ROOMS</span>
            <h1>Your jams</h1>
            <p>One link, one queue, and no debate about which music app everyone uses.</p>
          </div>
          <button type="button" className="button button-primary" onClick={() => openModal("create-jam")}>
            <Plus size={17} /> Start a jam
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
          <p>Everyone adds songs from the app they already use. UniJam matches, deduplicates, and keeps both playlists current.</p>
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
          <p>A clear record of songs, syncs, collaborators, and decisions.</p>
        </div>
        <button type="button" className="button button-outline" onClick={() => notify("Activity log exported as CSV.")}>
          <Download size={17} /> Export history
        </button>
      </header>
      <div className="activity-layout">
        <section className="content-panel activity-timeline">
          <div className="panel-toolbar activity-toolbar">
            <div className="filter-tabs">
              {["All activity", "People", "Syncs", "Matches"].map((filter) => (
                <button key={filter} type="button" className={activityFilter === filter ? "active" : ""} onClick={() => setActivityFilter(filter)}>{filter}</button>
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
            <div className="summary-metric"><strong>74</strong><span>songs synchronized</span></div>
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
            <p>Every playlist change can be rolled back for 30 days.</p>
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
          <p>Choose how UniJam matches, syncs, and protects your library.</p>
        </div>
        <span className="saved-indicator"><Check size={15} /> Changes save automatically</span>
      </header>
      <div className="settings-grid">
        <div className="settings-main">
          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><Link2 size={18} /></span><div><h2>Connected accounts</h2><p>Your source libraries and storefronts.</p></div></div></div>
            <div className="connection-card">
              <span className="service-mark spotify-mark large">≋</span>
              <div><strong>Spotify</strong><span>@masonwyatt · Connected Jul 3</span></div>
              <span className="connection-health"><CheckCircle2 size={15} /> Healthy</span>
              <button type="button" className="button button-small" onClick={() => openModal("account")}>Manage</button>
            </div>
            <div className="connection-card">
              <span className="service-mark apple-mark large"><Apple size={18} /></span>
              <div><strong>Apple Music</strong><span>United States · Connected Jul 3</span></div>
              <span className="connection-health"><CheckCircle2 size={15} /> Healthy</span>
              <button type="button" className="button button-small" onClick={() => openModal("account")}>Manage</button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><RefreshCw size={18} /></span><div><h2>Sync behavior</h2><p>Control when and how changes move between platforms.</p></div></div></div>
            <div className="setting-row"><div><strong>Automatic bidirectional sync</strong><span>Apply trusted changes from either platform within a few minutes.</span></div><Toggle checked={settingsState.autoSync} onChange={() => setSetting("autoSync")} label="Automatic bidirectional sync" /></div>
            <div className="setting-row"><div><strong>Automatic deduplication</strong><span>Collapse exact duplicates while preserving useful regional versions.</span></div><Toggle checked={settingsState.dedupe} onChange={() => setSetting("dedupe")} label="Automatic deduplication" /></div>
            <div className="setting-row"><div><strong>Preview risky changes</strong><span>Always ask before removals, low-confidence matches, or large reorders.</span></div><span className="locked-setting"><Lock size={13} /> Always on</span></div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><SlidersHorizontal size={18} /></span><div><h2>Version preferences</h2><p>Teach the matching engine which release belongs in your library.</p></div></div></div>
            <div className="setting-row"><div><strong>Prefer lossless versions</strong><span>Favor Apple Lossless where the recording and master match.</span></div><Toggle checked={settingsState.preferLossless} onChange={() => setSetting("preferLossless")} label="Prefer lossless versions" /></div>
            <div className="setting-row"><div><strong>Exclude explicit versions</strong><span>Prefer clean releases when both are available.</span></div><Toggle checked={settingsState.excludeExplicit} onChange={() => setSetting("excludeExplicit")} label="Exclude explicit versions" /></div>
            <div className="setting-row"><div><strong>Keep regional variants</strong><span>Preserve alternate catalog versions instead of merging them.</span></div><Toggle checked={settingsState.keepRegional} onChange={() => setSetting("keepRegional")} label="Keep regional variants" /></div>
          </section>

          <section className="settings-section">
            <div className="settings-heading"><div><span className="settings-icon"><ShieldCheck size={18} /></span><div><h2>Privacy & presence</h2><p>Your listening data is private by default.</p></div></div></div>
            <div className="setting-row"><div><strong>Local-first Master Library</strong><span>Keep the canonical library index on this device when available.</span></div><Toggle checked={settingsState.localFirst} onChange={() => setSetting("localFirst")} label="Local-first Master Library" /></div>
            <div className="setting-row"><div><strong>Show listening presence in jams</strong><span>Let collaborators see when you are listening in a shared room.</span></div><Toggle checked={settingsState.listeningPresence} onChange={() => setSetting("listeningPresence")} label="Listening presence" /></div>
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
            <p>Tokens are encrypted. Your music data is never sold or used for model training.</p>
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
    <Modal title={createStep === 3 ? "Your jam is live." : "Start a new jam"} eyebrow={createStep < 3 ? "CROSS-PLATFORM ROOM" : "READY TO SHARE"} onClose={closeModal}>
      {createStep === 1 && (
        <div className="modal-body">
          <div className="step-indicator"><span className="active">1</span><i /><span>2</span><i /><span>3</span></div>
          <label className="field-label">Jam name<input value={jamName} onChange={(event) => setJamName(event.target.value)} autoFocus /></label>
          <div className="field-label">
            Start with
            <div className="choice-grid">
              <button type="button" className="choice-card selected"><span className="choice-icon"><Sparkles size={20} /></span><strong>Fresh queue</strong><small>Start empty and build it together</small><CheckCircle2 size={17} /></button>
              <button type="button" className="choice-card"><span className="choice-icon"><ListMusic size={20} /></span><strong>A playlist</strong><small>Turn an existing playlist into a jam</small></button>
            </div>
          </div>
          <div className="modal-actions"><button type="button" className="button button-quiet" onClick={closeModal}>Cancel</button><button type="button" className="button button-primary" onClick={() => setCreateStep(2)}>Choose access <ArrowRight size={16} /></button></div>
        </div>
      )}
      {createStep === 2 && (
        <div className="modal-body">
          <div className="step-indicator"><span className="done"><Check size={13} /></span><i className="done" /><span className="active">2</span><i /><span>3</span></div>
          <label className="field-label">Who can participate?</label>
          <div className="radio-stack">
            {[
              ["Anyone with the link can add songs", "Fastest for a party, road trip, or group chat", Globe2],
              ["Only invited people can add songs", "Everyone else opens the jam as a listener", Users],
              ["View only", "You control the queue; friends can listen and react", Lock],
            ].map(([title, copy, Icon]) => (
              <button key={title as string} type="button" className={"radio-card" + (jamPermission === title ? " selected" : "")} onClick={() => setJamPermission(title as string)}>
                <span className="radio-control"><span /></span><Icon size={19} /><span><strong>{title as string}</strong><small>{copy as string}</small></span>
              </button>
            ))}
          </div>
          <div className="toggle-inline"><div><strong>Live listening</strong><span>Keep playback position in sync for the room.</span></div><Toggle checked={true} onChange={() => notify("Live listening can be changed later.")} label="Live listening" /></div>
          <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => setCreateStep(1)}><ArrowLeft size={16} /> Back</button><button type="button" className="button button-primary" onClick={createJam}>Create jam <ArrowRight size={16} /></button></div>
        </div>
      )}
      {createStep === 3 && (
        <div className="modal-body success-body">
          <span className="success-orbit"><Music2 size={27} /></span>
          <h3>{jamName}</h3>
          <p>Spotify and Apple Music friends can join with the same link.</p>
          <div className="share-field"><Link2 size={16} /><span>unijam.music/jam/saturday-staunton</span><button type="button" onClick={copyShareLink}><Copy size={16} /> Copy</button></div>
          <div className="platform-ready-row"><span><span className="service-mark spotify-mark">≋</span> Spotify ready</span><span><span className="service-mark apple-mark"><Apple size={12} /></span> Apple Music ready</span></div>
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={copyShareLink}><Share2 size={16} /> Share link</button><button type="button" className="button button-primary" onClick={() => { closeModal(); setView("jams"); }}>Open jam <ArrowRight size={16} /></button></div>
        </div>
      )}
    </Modal>
  );

  const renderImportModal = () => (
    <Modal title="Import a playlist" eyebrow="PREVIEW BEFORE SYNC" onClose={closeModal} wide={importStep === 3}>
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
          <label className="destination-choice"><span><strong>Create matching playlist on {importSource === "spotify" ? "Apple Music" : "Spotify"}</strong><small>Then keep changes synced in both directions</small></span><Toggle checked={true} onChange={() => notify("Destination is required for a cross-platform sync.")} label="Create matching playlist" /></label>
          <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => setImportStep(1)}><ArrowLeft size={16} /> Back</button><button type="button" className="button button-primary" onClick={applyImport}>Apply 18 tracks <ArrowRight size={16} /></button></div>
        </div>
      )}
      {importStep === 4 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><RefreshCw size={24} /></span>
          <h3>Building your unified playlist…</h3>
          <p>Writing matched tracks and preserving the original order.</p>
        </div>
      )}
    </Modal>
  );

  const renderSyncModal = () => (
    <Modal title={syncStep === 3 ? "Everything is in tune." : "Sync preview"} eyebrow="ZERO-SURPRISE SYNC" onClose={closeModal} wide>
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
              <button type="button" className="version-option selected"><PlatformMark platform="apple" /><span><strong>Currents</strong><small>Apple Lossless · 5:19</small></span><CheckCircle2 size={17} /></button>
            </div>
            <p><Sparkles size={14} /> UniJam chose the lossless version because the recording and duration are identical.</p>
          </div>
          <div className="safety-note"><ShieldCheck size={17} /><span><strong>Nothing is removed.</strong> You can roll back this sync for 30 days.</span></div>
          <div className="modal-actions split"><button type="button" className="button button-outline" onClick={() => notify("Detailed change list expanded.")}>View all changes</button><button type="button" className="button button-primary" onClick={startSync}>Apply 4 changes <ArrowRight size={16} /></button></div>
        </div>
      )}
      {syncStep === 2 && (
        <div className="modal-body processing-body">
          <span className="processing-rings"><RefreshCw size={24} /></span>
          <h3>Keeping both sides in tune…</h3>
          <p>Writing changes safely. This screen can be closed at any time.</p>
          <div className="progress-track"><span style={{ width: syncProgress + "%" }} /></div>
          <span className="progress-label">{syncProgress}% complete</span>
        </div>
      )}
      {syncStep === 3 && (
        <div className="modal-body success-body">
          <span className="success-orbit"><Check size={27} /></span>
          <h3>4 changes applied</h3>
          <p>Spotify and Apple Music now have the same tracks, versions, and order.</p>
          <div className="completed-breakdown"><span><Check size={14} /> 3 songs added</span><span><Check size={14} /> 1 track reordered</span><span><Check size={14} /> Lossless version preferred</span></div>
          <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => notify("Restore point created and available for 30 days.")}><History size={16} /> View history</button><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>
        </div>
      )}
    </Modal>
  );

  const renderEnhanceModal = () => (
    <Modal title="Enhance this playlist" eyebrow="TASTEFUL, NOT RANDOM" onClose={closeModal} wide>
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
    <Modal title="Share across platforms" eyebrow="ONE LINK FOR EVERYONE" onClose={closeModal}>
      <div className="modal-body">
        <div className="share-visual"><span className="service-mark spotify-mark large">≋</span><span className="link-orbit"><Link2 size={20} /></span><span className="service-mark apple-mark large"><Apple size={18} /></span></div>
        <p className="center-copy">Friends open UniJam, connect their preferred app, and add songs without switching services.</p>
        <div className="share-field"><Link2 size={16} /><span>unijam.music/jam/friday-night</span><button type="button" onClick={copyShareLink}><Copy size={16} /> Copy</button></div>
        <label className="field-label">Link permission<button type="button" className="select-field simple"><span><Globe2 size={17} /> Anyone with the link can add songs</span><ChevronDown size={16} /></button></label>
        <div className="invite-list"><div className="person-row"><Avatar name="Maya" tone="coral" size="sm" /><div><strong>Maya</strong><span>Apple Music · Editor</span></div><span className="presence-dot" /></div><div className="person-row"><Avatar name="Alex" tone="sage" size="sm" /><div><strong>Alex</strong><span>Spotify · Editor</span></div><span className="presence-dot" /></div></div>
        <div className="modal-actions"><button type="button" className="button button-outline" onClick={() => notify("Invitation message ready.")}><MessageCircle size={16} /> Send message</button><button type="button" className="button button-primary" onClick={copyShareLink}><Copy size={16} /> Copy jam link</button></div>
      </div>
    </Modal>
  );

  const renderMatchModal = () => (
    <Modal title="Choose the right version" eyebrow="MATCH REVIEW" onClose={closeModal} wide>
      <div className="modal-body match-review-body">
        <div className="source-track">
          <span className="eyebrow">ORIGINAL ON SPOTIFY</span>
          <div><TrackArt art="art-c" large /><span><strong>Nights</strong><small>Frank Ocean · Blonde · 5:07</small></span><PlatformMark platform="spotify" /></div>
        </div>
        <p className="match-explanation"><Sparkles size={15} /> UniJam found two likely Apple Music matches. Audio version, duration, and release metadata are weighted separately.</p>
        <div className="candidate-list">
          <button type="button" className="candidate-card selected"><span className="custom-radio"><span /></span><TrackArt art="art-c" large /><div><strong>Nights</strong><span>Frank Ocean · Blonde</span><small>Same ISRC · Duration +0s · Explicit</small></div><span className="candidate-score"><strong>96%</strong><small>Best match</small></span></button>
          <button type="button" className="candidate-card"><span className="custom-radio"><span /></span><TrackArt art="art-a" large /><div><strong>Nights</strong><span>Frank Ocean · Live at FYF</span><small>Different ISRC · Duration +42s · Live</small></div><span className="candidate-score low"><strong>61%</strong><small>Possible</small></span></button>
        </div>
        <div className="modal-actions split"><button type="button" className="button button-quiet" onClick={() => notify("Track left unmatched for now.")}>Leave unmatched</button><button type="button" className="button button-primary" onClick={() => { closeModal(); notify("Match confirmed. UniJam will remember this correction."); }}>Confirm match <ArrowRight size={16} /></button></div>
      </div>
    </Modal>
  );

  const renderAccountModal = () => (
    <Modal title="Connected accounts" eyebrow="HEALTHY CONNECTIONS" onClose={closeModal}>
      <div className="modal-body">
        <div className="account-detail-card"><span className="service-mark spotify-mark large">≋</span><div><strong>Spotify</strong><span>@masonwyatt</span><small><CheckCircle2 size={13} /> Token healthy · 6 scopes granted</small></div><button type="button" className="button button-small" onClick={() => notify("Spotify connection refreshed.")}>Refresh</button></div>
        <div className="account-detail-card"><span className="service-mark apple-mark large"><Apple size={18} /></span><div><strong>Apple Music</strong><span>United States storefront</span><small><CheckCircle2 size={13} /> Music User Token healthy</small></div><button type="button" className="button button-small" onClick={() => notify("Apple Music connection refreshed.")}>Refresh</button></div>
        <div className="scope-note"><ShieldCheck size={17} /><p><strong>Your credentials stay encrypted.</strong><br />UniJam only requests access needed to read and update your music library.</p></div>
        <div className="modal-actions"><button type="button" className="button button-quiet danger-text" onClick={() => notify("Disconnect requires a second confirmation.")}>Disconnect account</button><button type="button" className="button button-primary" onClick={closeModal}>Done</button></div>
      </div>
    </Modal>
  );

  return (
    <div className="app-shell">
      <button type="button" className={"mobile-overlay" + (mobileNavOpen ? " visible" : "")} onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />
      <aside className={"sidebar" + (mobileNavOpen ? " open" : "")}>
        <div className="brand" onClick={() => goTo("home")} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && goTo("home")}>
          <span className="brand-mark"><Music2 size={18} /></span>
          <span>UniJam</span>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => goTo(item.id)}>
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

      <main className="workspace">
        <header className="mobile-header">
          <button type="button" className="mobile-brand" onClick={() => goTo("home")}><Music2 size={17} /><span>UniJam</span></button>
          <button type="button" className="icon-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={21} /></button>
        </header>
        {renderCurrentView()}
      </main>

      {isPlaying && (
        <div className="global-player">
          <TrackArt art="art-a" />
          <div><strong>Pink + White</strong><span>Frank Ocean · Friday Night Jam</span></div>
          <button type="button" className="mini-play" onClick={() => setIsPlaying(false)} aria-label="Pause"><Pause size={17} fill="currentColor" /></button>
          <div className="global-progress"><span /></div>
          <span>1:24 / 3:04</span>
          <button type="button" className="icon-button dark-button" aria-label="Open player"><ChevronDown size={17} /></button>
        </div>
      )}

      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span></div>}
      {modal === "create-jam" && renderCreateJamModal()}
      {modal === "import" && renderImportModal()}
      {modal === "sync" && renderSyncModal()}
      {modal === "enhance" && renderEnhanceModal()}
      {modal === "share" && renderShareModal()}
      {modal === "match" && renderMatchModal()}
      {modal === "account" && renderAccountModal()}
    </div>
  );
}
