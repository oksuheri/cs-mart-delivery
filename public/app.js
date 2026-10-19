/**
 * CS Mart Delivery - Progressive Web App (PWA)
 * Core Frontend Logic, State Management, IndexedDB Offline Cache,
 * Interactive Cart, Zoom Gallery, 2-Way Chat, Role Portals, and Cashier Top-up.
 *
 * Update:
 * 1. Product photos upload to system folder (/public/uploads)
 * 2. Dedicated Login & Register page
 * 3. Locked viewport without horizontal shift
 * 4. PWA install prompt on first open
 * 5. Multi-photo product cards with numbered indicators (1, 2, 3...) & auto-slide
 * 6. Central Admin store CRUD and Active/Inactive toggle
 * 7. Mandatory device location & push notification permission prompt
 */

// Global State
const appState = {
  currentRole: 'consumer',
  currentUser: null,
  allUsers: [],
  currentStoreId: 'store-kemang',
  stores: [],
  products: [],
  categories: ['Semua'],
  activeCategory: 'Semua',
  activeFilter: null, // 'discount', 'free_shipping', 'featured'
  activeSort: 'recommended',
  searchQuery: '',
  cart: [], // [{ product, quantity, item_note }]
  activeOrder: null,
  notifications: [
    { id: 'notif-1', title: 'Selamat Datang di CS Mart!', body: 'Nikmati belanja kebutuhan minimarket cepat dengan gratis ongkir.', time: '10:00', read: false },
    { id: 'notif-2', title: 'Cashback Koin Member', body: 'Belanja akhir pekan dan dapatkan poin loyalitas berlipat.', time: '09:30', read: false }
  ],
  wishlist: [],
  isOffline: !navigator.onLine,
  lastSyncTime: null,
  adminActiveTab: 'dashboard',
  courierActiveTab: 'tasks',
  chatInterval: null,
  courierSimInterval: null,
  deferredInstallPrompt: null,
  productSlideInterval: null
};

// IndexedDB Helper for Offline Catalog
const DB_NAME = 'CSMartOfflineDB';
const DB_VERSION = 1;

function initIndexedDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('catalog')) {
        db.createObjectStore('catalog', { keyPath: 'store_id' });
      }
      if (!db.objectStoreNames.contains('stores')) {
        db.createObjectStore('stores', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('profile')) {
        db.createObjectStore('profile', { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => resolve(null);
  });
}

async function saveOfflineCatalog(storeId, products, categories, syncTime) {
  try {
    const db = await initIndexedDB();
    if (!db) return;
    const tx = db.transaction('catalog', 'readwrite');
    const store = tx.objectStore('catalog');
    store.put({ store_id: storeId, products, categories, syncTime });
  } catch (err) {
    console.warn('Could not save to IndexedDB', err);
  }
}

async function loadOfflineCatalog(storeId) {
  try {
    const db = await initIndexedDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction('catalog', 'readonly');
      const store = tx.objectStore('catalog');
      const req = store.get(storeId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

// Format currency
function formatRupiah(num) {
  return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

// App Controller Object
const app = {
  async init() {
    console.log('[CS Mart] Initializing App...');
    this.registerServiceWorker();
    this.setupNetworkListeners();
    this.fetchTunnelUrl(); // Ambil tunnel Cloudflare HTTPS aktif untuk popup 1-klik otomatis
    this.setupPwaInstallPrompt(); // Update 4: PWA Install Notification on initial open
    await this.fetchUsers();
    await this.fetchStores();

    // Check saved session or fallback to default Siti Rahma
    const savedUserId = localStorage.getItem('cs_mart_active_user_id') || 'usr-siti';
    await this.fetchUserProfile(savedUserId);
    await this.loadCatalog();
    this.render();

    this.checkInitialPromoPopup();
    this.checkDevicePermissions(); // Update 7: Mandatory location & push notification permission
    this.updateNotificationBadge();
    this.startProductCardAutoSlide(); // Update 5: Multi-photo auto-slide with 1, 2, 3...
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('[PWA] Service Worker registered successfully');
      }).catch((err) => {
        console.warn('[PWA] Service Worker registration failed', err);
      });
    }
  },

  setupNetworkListeners() {
    window.addEventListener('online', () => {
      appState.isOffline = false;
      this.updateNetworkUI();
      this.refreshCatalog();
    });
    window.addEventListener('offline', () => {
      appState.isOffline = true;
      this.updateNetworkUI();
    });
    this.updateNetworkUI();
  },

  async fetchTunnelUrl() {
    try {
      const res = await fetch('/api/pwa/tunnel-url');
      const data = await res.json();
      if (data && data.tunnel_url) {
        appState.tunnelUrl = data.tunnel_url;
        console.log('[PWA] Active 1-click public HTTPS tunnel:', appState.tunnelUrl);
      }
    } catch (e) {
      console.warn('Could not fetch tunnel url', e);
    }
  },

  updateNetworkUI() {
    const badge = document.getElementById('network-status-badge');
    const text = document.getElementById('network-status-text');
    const banner = document.getElementById('offline-banner');
    const syncTimeEl = document.getElementById('offline-sync-time');

    if (appState.isOffline) {
      badge.className = 'status-badge-network offline';
      text.textContent = 'Offline';
      banner.style.display = 'flex';
      syncTimeEl.textContent = appState.lastSyncTime || 'Sesi ini';
    } else {
      badge.className = 'status-badge-network online';
      text.textContent = 'Online';
      banner.style.display = 'none';
    }
  },

  /* =========================================================================
     UPDATE 4: UNIVERSAL 1-CLICK PWA INSTALLATION SYSTEM
     (Android 7+, iOS, Tablet, and Desktop Chrome/Edge/Samsung/Opera)
     ========================================================================= */
  setupPwaInstallPrompt() {
    // Check if already running in standalone mode (already installed)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                         window.navigator.standalone === true ||
                         document.referrer.includes('android-app://');
    if (isStandalone) {
      console.log('[PWA] App is already running in standalone mode');
      return;
    }

    // Sync prompt from early head interceptor or listen
    if (window.deferredInstallPrompt) {
      appState.deferredInstallPrompt = window.deferredInstallPrompt;
    }
    window.addEventListener('csmart-install-ready', () => {
      appState.deferredInstallPrompt = window.deferredInstallPrompt;
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      appState.deferredInstallPrompt = e;
      window.deferredInstallPrompt = e;
    });
    window.addEventListener('csmart-installed', () => {
      this.dismissPwaInstall();
      this.showInstallSuccessModal();
    });
    window.addEventListener('appinstalled', () => {
      this.dismissPwaInstall();
      this.showInstallSuccessModal();
    });

    // Display install notification banner 600ms after load
    setTimeout(() => {
      this.showPwaInstallNotification();
    }, 600);

    // Auto-trigger install prompt if redirected with ?install=1
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('install') === '1') {
      setTimeout(() => {
        this.triggerPwaInstall();
      }, 900);
    }
  },

  showPwaInstallNotification() {
    if (document.getElementById('pwa-install-banner')) return;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) return;

    const unread = appState.notifications.filter(n => !n.read).length;
    const bannerHtml = `
      <div id="pwa-install-banner" class="pwa-install-banner" role="alert">
        <div class="app-icon-wrap" style="flex-shrink:0;">
          <img src="/assets/icon-192.png" style="width:44px; height:44px; border-radius:10px; object-fit:cover; border:1.5px solid var(--accent-yellow);">
          ${unread > 0 ? `<span class="app-icon-badge" style="top:-3px; right:-3px; font-size:0.6rem; min-width:16px; height:16px;">${unread}</span>` : ''}
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:800; font-size:0.88rem; color:#dbc911; display:flex; align-items:center; gap:5px;">
            <span>📲</span> Pasang Aplikasi CS Mart
          </div>
          <div style="font-size:0.75rem; color:#e2e8f0; line-height:1.3; margin-top:2px;">
            Instal langsung ke layar utama perangkat untuk belanja instan & offline.
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
          <button id="btn-pwa-install-action" class="btn-topup-cash" style="font-size:0.75rem; font-weight:800; padding:8px 14px; white-space:nowrap; background:#dbc911; color:#090765; border:none; border-radius:var(--radius-full); cursor:pointer;" onclick="app.triggerPwaInstall()">
            ⚡ Pasang Sekarang
          </button>
          <button style="background:transparent; border:none; color:#cbd5e1; font-size:0.68rem; cursor:pointer; text-align:center;" onclick="app.dismissPwaInstall()">
            Nanti Saja
          </button>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', bannerHtml);
  },

  async triggerPwaInstall() {
    const btn = document.getElementById('btn-pwa-install-action');
    if (btn) {
      btn.innerHTML = '⏳ Memproses...';
      btn.disabled = true;
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    // A. JIKA PERANGKAT ADALAH iOS (iPhone / iPad)
    if (isIOS) {
      window.location.href = '/csmart.mobileconfig';
      this.dismissPwaInstall();
      this.showIosInstallModal();
      return;
    }

    // B. JIKA NATIVE PROMPT SUDAH TERSEDIA (Event beforeinstallprompt sudah ditangkap)
    let promptEvent = window.deferredInstallPrompt || appState.deferredInstallPrompt;

    if (!promptEvent) {
      promptEvent = await new Promise((resolve) => {
        if (window.deferredInstallPrompt) return resolve(window.deferredInstallPrompt);
        const onReady = () => {
          window.removeEventListener('csmart-install-ready', onReady);
          resolve(window.deferredInstallPrompt);
        };
        window.addEventListener('csmart-install-ready', onReady);
        setTimeout(() => resolve(window.deferredInstallPrompt || null), 800);
      });
    }

    if (promptEvent) {
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        console.log('[PWA] User response to native install prompt:', choice.outcome);
        if (choice.outcome === 'accepted') {
          this.dismissPwaInstall();
          this.showInstallSuccessModal();
        } else {
          if (btn) {
            btn.innerHTML = '⚡ Pasang Sekarang';
            btn.disabled = false;
          }
        }
        window.deferredInstallPrompt = null;
        appState.deferredInstallPrompt = null;
        return;
      } catch (err) {
        console.warn('[PWA] Native prompt execution error:', err);
      }
    }

    // C. JIKA NATIVE PROMPT BELUM MUNCUL KARENA DIAKSES VIA IP LOKAL (SELF-SIGNED SSL):
    // Chrome Android menolak event popup otomatis pada SSL mandiri. Arahkan langsung ke Cloudflare HTTPS terverifikasi!
    if (appState.tunnelUrl && !window.location.href.startsWith(appState.tunnelUrl)) {
      window.location.href = `${appState.tunnelUrl}/?install=1`;
      return;
    }

    this.dismissPwaInstall();
    this.showDirectInstallModal();
  },

  showInstallSuccessModal() {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:420px; text-align:center; padding:28px 20px;" onclick="event.stopPropagation()">
          <div style="font-size:3rem; margin-bottom:12px;">🎉📲</div>
          <h2 style="color:var(--primary); font-size:1.3rem; font-weight:800; margin-bottom:8px;">
            Aplikasi Berhasil Dipasang!
          </h2>
          <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin-bottom:20px;">
            Ikon <strong>CS Mart Delivery</strong> sekarang sudah terpasang di layar utama perangkat Anda. Anda dapat langsung membukanya kapan saja seperti aplikasi bawaan (native app)!
          </p>
          <button class="btn-checkout-submit" style="background:var(--primary); width:100%;" onclick="app.closeModal()">
            Mulai Belanja 🛍️
          </button>
        </div>
      </div>
    `;
  },

  showIosInstallModal() {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px; padding:24px 20px;" onclick="event.stopPropagation()">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <img src="/assets/icon-apple-touch.png" style="width:36px; height:36px; border-radius:8px;">
              <div style="font-weight:800; font-size:1rem; color:var(--primary);">Pasang di iPhone / iPad</div>
            </div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:28px; height:28px; font-size:0.85rem;">✕</button>
          </div>
          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:14px; margin-bottom:16px; font-size:0.82rem; line-height:1.5; color:#1e40af;">
            <div style="font-weight:700; margin-bottom:4px; font-size:0.88rem;">📲 Profil Web Clip Sedang Diunduh!</div>
            Buka menu <strong>Pengaturan (Settings)</strong> pada iPhone/iPad Anda, pilih <strong>Profil Diunduh (Profile Downloaded)</strong> di bagian atas, lalu ketuk <strong>Pasang (Install)</strong>.
          </div>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:18px;">
            Atau jika menggunakan Safari: Ketuk tombol <strong>Bagikan (Share <span style="font-size:1rem;">⎕↑</span>)</strong> di baris bawah Safari, lalu pilih <strong>Tambah ke Layar Utama (+)</strong>.
          </div>
          <button class="btn-checkout-submit" style="background:var(--primary); width:100%;" onclick="app.closeModal()">
            Mengerti & Selesai
          </button>
        </div>
      </div>
    `;
  },

  showDirectInstallModal() {
    const isSecure = window.isSecureContext;
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const container = document.getElementById('modal-container');

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px; padding:24px 20px;" onclick="event.stopPropagation()">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <img src="/assets/icon-192.png" style="width:36px; height:36px; border-radius:8px;">
              <div style="font-weight:800; font-size:1rem; color:var(--primary);">Instalasi Aplikasi CS Mart</div>
            </div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:28px; height:28px; font-size:0.85rem;">✕</button>
          </div>
          
          ${appState.tunnelUrl && !window.location.href.startsWith(appState.tunnelUrl) ? `
          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:14px; margin-bottom:16px;">
            <div style="font-size:0.88rem; font-weight:800; color:#1e40af; margin-bottom:4px;">
              🚀 Pasang Otomatis 1-Klik (Cloudflare HTTPS)
            </div>
            <div style="font-size:0.78rem; color:#1e3a8a; line-height:1.4; margin-bottom:12px;">
              Untuk memunculkan dialog popup instalasi native 1-klik langsung di layar HP (tanpa buka menu titik tiga), buka melalui tautan HTTPS terverifikasi resmi berikut:
            </div>
            <a href="${appState.tunnelUrl}/?install=1" class="btn-checkout-submit" style="display:block; text-align:center; text-decoration:none; background:#090765; color:#dbc911; font-weight:800; padding:10px;">
              ⚡ Buka & Pasang Otomatis 1-Klik
            </a>
          </div>
          ` : `
          <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:14px; margin-bottom:16px; text-align:left;">
            <div style="font-size:0.88rem; font-weight:800; color:#166534; margin-bottom:4px;">
              📲 Pasang dari Menu Browser
            </div>
            <div style="font-size:0.78rem; color:#15803d; line-height:1.4;">
              1. Ketuk ikon titik tiga (<strong>⋮</strong>) di pojok kanan atas browser.<br>
              2. Pilih <strong>"Pasang aplikasi"</strong> atau <strong>"Tambahkan ke Layar Utama"</strong>.
            </div>
          </div>
          `}

          <div style="display:flex; flex-direction:column; gap:8px;">
            <button class="btn-checkout-submit" style="background:var(--primary); width:100%;" onclick="app.retryPromptOrReload()">
              🔄 Muat Ulang Halaman
            </button>
            <button class="filter-pill" style="width:100%; text-align:center; padding:10px;" onclick="app.closeModal()">
              Tutup
            </button>
          </div>
        </div>
      </div>
    `;
  },

  retryPromptOrReload() {
    this.closeModal();
    if (window.deferredInstallPrompt) {
      this.triggerPwaInstall();
    } else {
      location.reload();
    }
  },

  dismissPwaInstall() {
    const el = document.getElementById('pwa-install-banner');
    if (el) el.remove();
  },

  /* =========================================================================
     UPDATE 7: MANDATORY LOCATION & PUSH NOTIFICATION PROMPT
     ========================================================================= */
  checkDevicePermissions() {
    const granted = localStorage.getItem('cs_mart_device_perm_v1');
    if (!granted) {
      setTimeout(() => {
        this.showMandatoryPermissionModal();
      }, 1400);
    }
  },

  showMandatoryPermissionModal() {
    if (document.getElementById('perm-dialog-overlay')) return;
    const overlayHtml = `
      <div id="perm-dialog-overlay" class="permission-dialog-overlay">
        <div class="permission-dialog-card">
          <div class="permission-icon-badge">📍🔔</div>
          <h2 style="font-size:1.2rem; font-weight:800; color:#090765; margin-bottom:8px;">
            Akses Lokasi & Notifikasi Diperlukan
          </h2>
          <p style="font-size:0.82rem; color:var(--text-muted); line-height:1.5; margin-bottom:18px;">
            Untuk memastikan pesanan minimarket dapat diantar secara akurat ke titik alamat dan menerima pembaruan kurir langsung, CS Mart Delivery memerlukan izin Lokasi dan Notifikasi Perangkat.
          </p>

          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px; text-align:left; font-size:0.78rem; margin-bottom:20px; display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:1.1rem;">📍</span>
              <div><strong>Akses Lokasi GPS:</strong> Menentukan toko cabang terdekat dan menghitung tarif ongkos kirim presisi.</div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:1.1rem;">🔔</span>
              <div><strong>Izin Push Notifikasi:</strong> Mendapatkan info pesanan dikemas, kurir jalan, dan balasan chat.</div>
            </div>
          </div>

          <button class="btn-checkout-submit" style="background:#090765; width:100%; margin-bottom:10px;" onclick="app.requestAllDevicePermissions()">
            Izinkan Lokasi & Notifikasi Sekarang 🚀
          </button>
          <button style="background:transparent; border:none; color:var(--text-muted); font-size:0.75rem; cursor:pointer;" onclick="app.closePermissionModal()">
            Lanjutkan
          </button>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', overlayHtml);
  },

  async requestAllDevicePermissions() {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          console.log('GPS obtained:', pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          console.warn('GPS error or denied:', err.message);
        },
        { timeout: 5000 }
      );
    }

    if ('Notification' in window) {
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          this.addNotification('Notifikasi Diaktifkan!', 'Anda sekarang akan menerima kabar status pesanan dan chat kurir langsung.');
        }
      } catch (e) {}
    }

    localStorage.setItem('cs_mart_device_perm_v1', 'true');
    this.closePermissionModal();
    alert('✅ Terima kasih! Izin lokasi dan notifikasi telah aktif.');
  },

  closePermissionModal() {
    const el = document.getElementById('perm-dialog-overlay');
    if (el) el.remove();
  },

  /* =========================================================================
     UPDATE 2: DEDICATED LOGIN & REGISTER PAGE
     ========================================================================= */
  openLoginModal() {
    const container = document.getElementById('modal-container');
    const u = appState.currentUser;

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width: 480px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius: var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">
              <span>👤 ${u ? 'Akun Pengguna' : 'Masuk ke CS Mart'}</span>
            </div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>

          <div style="padding: 22px;">
            ${u ? `
              <!-- User Profile & Switch or Logout -->
              <div style="text-align:center; margin-bottom:20px;">
                <div style="width:60px; height:60px; border-radius:50%; background:#090765; color:#dbc911; font-size:1.8rem; font-weight:800; display:flex; align-items:center; justify-content:center; margin:0 auto 10px auto; border:2px solid #dbc911;">
                  ${u.name ? u.name.charAt(0) : 'U'}
                </div>
                <h3 style="font-size:1.15rem; font-weight:800; color:var(--primary);">${u.name}</h3>
                <div style="font-size:0.8rem; color:var(--text-muted);">${u.phone || u.email || 'Konsumen'}</div>
                <div style="margin-top:6px;">
                  <span class="tier-pill" style="display:inline-flex;">⭐ Tier ${u.tier || 'Silver'} Member</span>
                </div>
              </div>

              <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:14px; margin-bottom:18px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:0.85rem;">
                  <span style="color:var(--text-muted);">Saldo CS Pay:</span>
                  <strong style="color:var(--primary); font-size:1rem;">${formatRupiah(u.wallet_balance || 0)}</strong>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:0.85rem;">
                  <span style="color:var(--text-muted);">Poin Loyalitas:</span>
                  <strong style="color:var(--primary);">${(u.points || 0).toLocaleString('id-ID')} Poin</strong>
                </div>
              </div>

              <div class="section-title" style="font-size:0.9rem; margin-bottom:8px;">Ganti Peran / Akun Pengguna:</div>
              <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:18px;">
                ${appState.allUsers.map(usr => `
                  <button class="filter-pill" style="text-align:left; justify-content:space-between; padding:8px 12px; ${usr.id === u.id ? 'border-color:var(--primary); background:#eff6ff;' : ''}" onclick="app.directLoginUser('${usr.id}')">
                    <span>${usr.name}</span>
                    <span class="role-tag" style="font-size:0.65rem;">${usr.role}</span>
                  </button>
                `).join('')}
              </div>

              <button class="btn-topup-cash" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; width:100%; padding:10px;" onclick="app.logoutUser()">
                🚪 Keluar / Ganti Akun Lain
              </button>
            ` : `
              <!-- Login / Register Form Tabs -->
              <div class="auth-tabs-row">
                <button id="auth-tab-login" class="auth-tab-btn active" onclick="app.switchAuthTab('login')">Masuk (Login)</button>
                <button id="auth-tab-register" class="auth-tab-btn" onclick="app.switchAuthTab('register')">Daftar Akun Baru</button>
              </div>

              <!-- Login Form -->
              <div id="auth-form-login">
                <div class="form-group">
                  <label class="form-label">Nomor Telepon WhatsApp / HP</label>
                  <input type="tel" id="login-phone" class="form-input" placeholder="Contoh: 081234567890" value="081234567890">
                </div>

                <div style="margin-bottom:14px; text-align:right;">
                  <button type="button" class="filter-pill" style="font-size:0.75rem; padding:4px 8px;" onclick="app.requestOtpDemo()">
                    Kirim OTP Demo via WhatsApp
                  </button>
                </div>

                <div class="form-group">
                  <label class="form-label">Kode OTP (4 Digit)</label>
                  <input type="text" id="login-otp" class="form-input" placeholder="Masukkan 1234" value="1234" maxlength="4">
                  <div style="font-size:0.72rem; color:var(--text-muted); margin-top:4px;">OTP Demo: <strong>1234</strong></div>
                </div>

                <button class="btn-checkout-submit" style="background:var(--primary); margin-top:14px;" onclick="app.submitLogin()">
                  Masuk Sekarang
                </button>

                <div style="margin-top:20px; text-align:center; font-size:0.8rem; color:var(--text-muted);">
                  Atau masuk instan dengan akun demo:
                </div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; justify-content:center;">
                  <button class="filter-pill" onclick="app.directLoginUser('usr-siti')">Siti (Konsumen)</button>
                  <button class="filter-pill" onclick="app.directLoginUser('usr-rian')">Rian (Admin Kemang)</button>
                  <button class="filter-pill" onclick="app.directLoginUser('usr-budi')">Budi (Kurir)</button>
                  <button class="filter-pill" onclick="app.directLoginUser('usr-admin-pusat')">Admin Pusat</button>
                </div>
              </div>

              <!-- Register Form -->
              <div id="auth-form-register" style="display:none;">
                <div class="form-group">
                  <label class="form-label">Nama Lengkap</label>
                  <input type="text" id="reg-name" class="form-input" placeholder="Nama Anda...">
                </div>
                <div class="form-group">
                  <label class="form-label">Nomor Telepon (WhatsApp)</label>
                  <input type="tel" id="reg-phone" class="form-input" placeholder="08xxxxxxxxxx">
                </div>
                <div class="form-group">
                  <label class="form-label">Email (Opsional)</label>
                  <input type="email" id="reg-email" class="form-input" placeholder="nama@email.com">
                </div>

                <div style="background:#fef9c3; border:1px solid #fde047; border-radius:8px; padding:10px; font-size:0.75rem; color:#854d0e; margin-bottom:14px;">
                  🎁 Dapatkan bonus Saldo CS Pay Rp 50.000 untuk pendaftaran akun baru hari ini!
                </div>

                <button class="btn-checkout-submit" style="background:var(--primary);" onclick="app.submitRegister()">
                  Daftar & Dapatkan Bonus Rp 50.000
                </button>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  },

  switchAuthTab(tab) {
    document.getElementById('auth-tab-login').classList.toggle('active', tab === 'login');
    document.getElementById('auth-tab-register').classList.toggle('active', tab === 'register');
    document.getElementById('auth-form-login').style.display = tab === 'login' ? 'block' : 'none';
    document.getElementById('auth-form-register').style.display = tab === 'register' ? 'block' : 'none';
  },

  requestOtpDemo() {
    alert('Kode OTP Demo: 1234 telah dikirim ke nomor WhatsApp Anda.');
    document.getElementById('login-otp').value = '1234';
  },

  async submitLogin() {
    const phone = document.getElementById('login-phone').value.trim();
    const otp = document.getElementById('login-otp').value.trim();

    if (!phone) {
      alert('Mohon masukkan nomor telepon.');
      return;
    }
    if (otp !== '1234') {
      alert('Kode OTP salah. Gunakan OTP demo: 1234');
      return;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, role: 'consumer' })
      });
      const data = await res.json();
      if (!res.ok || !data.user) {
        alert(data.message || data.error || 'Login gagal. Pastikan server backend (server.py) sedang berjalan.');
        return;
      }
      appState.currentUser = data.user;
      appState.currentRole = data.user.role;
      localStorage.setItem('cs_mart_active_user_id', data.user.id);
      this.closeModal();
      this.updateHeaderUserInfo();
      this.render();
      alert(`Selamat datang kembali, ${data.user.name}!`);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  },

  async submitRegister() {
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const email = document.getElementById('reg-email').value.trim();

    if (!name || !phone) {
      alert('Nama dan Nomor Telepon wajib diisi.');
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, email })
      });
      const data = await res.json();
      if (!res.ok || !data.user) {
        alert(data.message || data.error || 'Pendaftaran gagal. Pastikan server backend (server.py) sedang berjalan.');
        return;
      }
      appState.currentUser = data.user;
      appState.currentRole = data.user.role;
      localStorage.setItem('cs_mart_active_user_id', data.user.id);
      this.closeModal();
      this.updateHeaderUserInfo();
      this.render();
      alert(`Selamat, ${data.user.name}! Akun Anda telah aktif dan bonus Saldo CS Pay Rp 50.000 telah masuk.`);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  },

  async directLoginUser(userId) {
    await this.fetchUserProfile(userId);
    localStorage.setItem('cs_mart_active_user_id', userId);
    // Update top role selector dropdown
    const roleSelect = document.getElementById('role-select');
    if (roleSelect) roleSelect.value = userId;

    if (appState.currentUser && appState.currentUser.store_id) {
      appState.currentStoreId = appState.currentUser.store_id;
    }
    this.closeModal();
    this.updateHeaderUserInfo();
    this.updateHeaderStoreName();
    this.render();
  },

  logoutUser() {
    localStorage.removeItem('cs_mart_active_user_id');
    appState.currentUser = null;
    appState.currentRole = 'consumer';
    this.closeModal();
    this.updateHeaderUserInfo();
    this.openLoginModal();
  },

  updateHeaderUserInfo() {
    const el = document.getElementById('header-user-name');
    if (el) {
      if (appState.currentUser) {
        el.textContent = appState.currentUser.name.split(' ')[0];
      } else {
        el.textContent = 'Masuk';
      }
    }
  },

  async fetchUsers() {
    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      if (data.users) {
        appState.allUsers = data.users;
      }
    } catch (err) {
      console.warn('Using cached user list', err);
    }
  },

  async fetchStores() {
    try {
      const res = await fetch('/api/stores');
      const data = await res.json();
      if (data.stores) {
        appState.stores = data.stores;
        const db = await initIndexedDB();
        if (db) {
          const tx = db.transaction('stores', 'readwrite');
          data.stores.forEach(st => tx.objectStore('stores').put(st));
        }
      }
    } catch (err) {
      console.warn('Network error loading stores, fallback to IndexedDB', err);
      const db = await initIndexedDB();
      if (db) {
        const tx = db.transaction('stores', 'readonly');
        const req = tx.objectStore('stores').getAll();
        req.onsuccess = () => {
          if (req.result && req.result.length > 0) appState.stores = req.result;
        };
      }
    }
  },

  async fetchUserProfile(userId) {
    try {
      const res = await fetch(`/api/users/profile?user_id=${userId}`);
      const data = await res.json();
      if (data.user) {
        appState.currentUser = data.user;
        appState.currentRole = data.user.role;
        this.updateHeaderUserInfo();
      }
    } catch (err) {
      console.warn('Network error loading user profile', err);
    }
  },

  async switchRole(userId) {
    await this.directLoginUser(userId);
  },

  updateHeaderStoreName() {
    const st = appState.stores.find(s => s.id === appState.currentStoreId);
    const storeBtn = document.getElementById('current-store-name');
    if (st && storeBtn) {
      storeBtn.textContent = `📍 ${st.name}`;
    }
  },

  async loadCatalog() {
    const storeId = appState.currentStoreId;
    const cat = appState.activeCategory;
    const filter = appState.activeFilter;
    const sort = appState.activeSort;
    const q = appState.searchQuery;

    let url = `/api/products?store_id=${storeId}&sort=${sort}`;
    if (cat && cat !== 'Semua') url += `&category=${encodeURIComponent(cat)}`;
    if (filter) url += `&filter=${filter}`;
    if (q) url += `&q=${encodeURIComponent(q)}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Gagal mengambil data dari server (Status ' + res.status + ')');
      const data = await res.json();
      if (data.success && Array.isArray(data.products)) {
        appState.products = data.products;
        appState.categories = data.categories || [];
        appState.lastSyncTime = new Date().toLocaleTimeString('id-ID');
        saveOfflineCatalog(storeId, data.products, data.categories, appState.lastSyncTime);
      } else {
        throw new Error(data.message || 'Katalog tidak valid');
      }
    } catch (err) {
      console.warn('Offline mode: loading from IndexedDB...', err);
      appState.isOffline = true;
      this.updateNetworkUI();
      const cached = await loadOfflineCatalog(storeId);
      if (cached) {
        let prods = cached.products;
        if (cat && cat !== 'Semua') prods = prods.filter(p => p.category === cat);
        if (filter === 'discount') prods = prods.filter(p => p.is_discount);
        if (filter === 'free_shipping') prods = prods.filter(p => p.is_free_shipping);
        if (filter === 'featured') prods = prods.filter(p => p.is_featured);
        if (q) {
          const lq = q.toLowerCase();
          prods = prods.filter(p => p.name.toLowerCase().includes(lq) || p.description.toLowerCase().includes(lq));
        }
        appState.products = prods;
        appState.categories = cached.categories;
        appState.lastSyncTime = cached.syncTime;
      }
    }
  },

  async refreshCatalog() {
    await this.loadCatalog();
    this.render();
  },

  // Main UI View Dispatcher
  render() {
    const container = document.getElementById('main-content');
    const storeBtn = document.getElementById('btn-store-picker');
    const headerCartBtn = document.getElementById('btn-header-cart');
    const mobileNav = document.getElementById('mobile-nav-bar');

    // Role-dependent UI adjustments
    if (appState.currentRole === 'consumer') {
      storeBtn.style.display = 'flex';
      headerCartBtn.style.display = 'flex';
      mobileNav.style.display = 'flex';
      this.renderConsumerView(container);
      this.updateFloatingCartBar();
    } else if (appState.currentRole === 'store_admin') {
      storeBtn.style.display = 'none';
      headerCartBtn.style.display = 'none';
      mobileNav.style.display = 'none';
      document.getElementById('floating-cart-bar').style.display = 'none';
      this.renderStoreAdminView(container);
    } else if (appState.currentRole === 'courier') {
      storeBtn.style.display = 'none';
      headerCartBtn.style.display = 'none';
      mobileNav.style.display = 'none';
      document.getElementById('floating-cart-bar').style.display = 'none';
      this.renderCourierView(container);
    } else if (appState.currentRole === 'central_admin') {
      storeBtn.style.display = 'none';
      headerCartBtn.style.display = 'none';
      mobileNav.style.display = 'none';
      document.getElementById('floating-cart-bar').style.display = 'none';
      this.renderCentralAdminView(container);
    }

    this.updateHeaderStoreName();
    this.updateNotificationBadge();
    this.updateHeaderUserInfo();
  },

  /* =========================================================================
     1. CONSUMER PORTAL
     ========================================================================= */
  renderConsumerView(container) {
    const u = appState.currentUser || {};
    const st = appState.stores.find(s => s.id === appState.currentStoreId) || {};
    
    // Calculate tier progress
    const spending = u.spending_period || 0;
    const goldMin = u.tier_gold_min || 500000;
    const platMin = u.tier_plat_min || 1500000;
    let nextTierName = 'Gold';
    let targetMin = goldMin;
    let progressPercent = Math.min(100, Math.round((spending / goldMin) * 100));

    if (u.tier === 'Gold') {
      nextTierName = 'Platinum';
      targetMin = platMin;
      progressPercent = Math.min(100, Math.round((spending / platMin) * 100));
    } else if (u.tier === 'Platinum') {
      nextTierName = 'Level Tertinggi';
      targetMin = platMin;
      progressPercent = 100;
    }

    // Recommendation items
    const recommendations = appState.products.slice(0, 4);

    container.innerHTML = `
      <!-- Badge Notification Launcher Trigger Banner -->
      <div id="badge-quick-banner" style="background: linear-gradient(135deg, #090765, #1e1b4b); border: 1.5px solid #ef4444; border-radius: var(--radius-lg); padding: 12px 14px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; box-shadow: 0 4px 15px rgba(239,68,68,0.25);">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="position:relative; width:40px; height:40px; flex-shrink:0;">
            <img src="/assets/icon-192.png" alt="CS Mart" style="width:40px; height:40px; border-radius:10px; border:1.5px solid #dbc911; object-fit:cover;">
          </div>
          <div style="font-size:0.8rem; color:#f8fafc; line-height:1.35;">
            <div style="font-weight:800; color:#fca5a5; display:flex; align-items:center; gap:5px;">
              <span>🔴</span> Titik Merah Ikon Layar HP
            </div>
            <div style="font-size:0.72rem; color:#cbd5e1; margin-top:2px;">
              Ketuk untuk aktifkan lencana titik merah di ikon HP Anda.
            </div>
          </div>
        </div>
        <button onclick="app.sendTestBadgeNotification()" style="background:#ef4444; color:#ffffff; border:none; padding:8px 14px; border-radius:var(--radius-full); font-weight:800; font-size:0.75rem; white-space:nowrap; cursor:pointer; box-shadow: 0 2px 8px rgba(239,68,68,0.5);">
          Aktifkan 🔴
        </button>
      </div>

      <!-- Member Summary Card (Addendum 22.1) -->
      <section class="member-summary-card" aria-label="Ringkasan Member">
        <div class="member-card-header">
          <div class="member-welcome-title">
            <span>Halo, ${u.name || 'Pelanggan Setia'} 👋</span>
          </div>
          <div class="tier-pill">
            ⭐ Tier ${u.tier || 'Silver'}
          </div>
        </div>

        <div class="member-stats-row">
          <div class="member-stat-box">
            <div class="stat-box-label">Saldo CS Pay</div>
            <div class="stat-box-value">${formatRupiah(u.wallet_balance || 0)}</div>
            <div class="stat-box-action">
              <button class="btn-topup-cash" onclick="app.openCashTopupModal()">+ Top Up Tunai di Kasir</button>
            </div>
          </div>

          <div class="member-stat-box">
            <div class="stat-box-label">Poin Loyalitas</div>
            <div class="stat-box-value">🪙 ${(u.points || 0).toLocaleString('id-ID')} Poin</div>
            <div class="stat-box-action">
              <span style="font-size:0.72rem; color:#cbd5e1;">1 Poin per Rp 1.000 belanja</span>
            </div>
          </div>
        </div>

        <div class="tier-progress-container">
          <div class="tier-progress-text">
            <span>Total belanja periode ini: <strong>${formatRupiah(spending)}</strong></span>
            <span>Target ${nextTierName}: ${formatRupiah(targetMin)}</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
          </div>
        </div>
      </section>

      <!-- Multi-Image Promo Banner Carousel (Addendum 24.3) -->
      <section class="carousel-section" aria-label="Promo Banners">
        <div class="carousel-wrapper" id="banner-carousel">
          <div class="carousel-slide active" data-index="0">
            <img src="/assets/promo_banner_1.jpg" alt="Promo Minimarket CS Mart">
            <div class="carousel-slide-overlay">
              <div class="carousel-slide-title">Diskon Besar Hingga 50%</div>
              <div class="carousel-slide-subtitle">Susu segar, biskuit, camilan & minyak goreng harga super hemat!</div>
            </div>
          </div>
          <div class="carousel-slide" data-index="1">
            <img src="https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=80" alt="Gratis Ongkir Se-Jakarta">
            <div class="carousel-slide-overlay">
              <div class="carousel-slide-title">Gratis Ongkir CS Mart Delivery</div>
              <div class="carousel-slide-subtitle">Belanja min. Rp 50.000 bebas ongkos kirim ke seluruh area layanan.</div>
            </div>
          </div>
          <div class="carousel-slide" data-index="2">
            <img src="https://images.unsplash.com/photo-1580828343064-fde4fc206bc6?auto=format&fit=crop&w=1200&q=80" alt="Double Point Reward">
            <div class="carousel-slide-overlay">
              <div class="carousel-slide-title">Dapatkan 2x Poin Member Akhir Pekan</div>
              <div class="carousel-slide-subtitle">Tukarkan poin loyalty untuk potongan belanja di pemesanan berikutnya.</div>
            </div>
          </div>

          <button class="carousel-btn prev" onclick="app.moveCarousel(-1)" aria-label="Slide sebelumnya">‹</button>
          <button class="carousel-btn next" onclick="app.moveCarousel(1)" aria-label="Slide berikutnya">›</button>

          <div class="carousel-indicators" id="carousel-indicators">
            <div class="indicator-dot active" onclick="app.setCarouselSlide(0)"></div>
            <div class="indicator-dot" onclick="app.setCarouselSlide(1)"></div>
            <div class="indicator-dot" onclick="app.setCarouselSlide(2)"></div>
          </div>
        </div>
      </section>

      <!-- Personalized Recommendations (Addendum 22.5) -->
      <section style="margin-bottom: 24px;">
        <div class="section-header">
          <div>
            <div class="section-title">✨ Rekomendasi Spesial Untuk Anda</div>
            <div class="section-subtitle">Paling sering dipesan pelanggan di ${st.name || 'CS Mart'}</div>
          </div>
        </div>
        <div class="product-grid" style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));">
          ${recommendations.map(p => this.renderProductCardHtml(p)).join('')}
        </div>
      </section>

      <!-- Catalog Controls: Search, Tag Filters, Categories, Sorting (PRD 23.2) -->
      <section class="catalog-controls">
        <div class="search-box-row">
          <div class="search-input-wrapper">
            <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" id="catalog-search" class="search-input" 
              placeholder="Cari produk minimarket (misal: Indomie, Susu, Minyak)..." 
              value="${appState.searchQuery}" 
              oninput="app.handleSearchInput(this.value)">
          </div>

          <select class="sort-select" onchange="app.handleSortChange(this.value)">
            <option value="recommended" ${appState.activeSort === 'recommended' ? 'selected' : ''}>Rekomendasi</option>
            <option value="az" ${appState.activeSort === 'az' ? 'selected' : ''}>Nama A–Z</option>
            <option value="za" ${appState.activeSort === 'za' ? 'selected' : ''}>Nama Z–A</option>
            <option value="price_asc" ${appState.activeSort === 'price_asc' ? 'selected' : ''}>Harga Terendah</option>
            <option value="price_desc" ${appState.activeSort === 'price_desc' ? 'selected' : ''}>Harga Tertinggi</option>
          </select>
        </div>

        <!-- Filter Tag Pills (Diskon, Gratis Ongkir, Unggulan) -->
        <div class="filter-pills-row">
          <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); margin-right:4px;">Filter:</span>
          <button class="filter-pill discount ${appState.activeFilter === 'discount' ? 'active' : ''}" 
            onclick="app.toggleFilter('discount')">
            🏷️ Sedang Diskon
          </button>
          <button class="filter-pill free-shipping ${appState.activeFilter === 'free_shipping' ? 'active' : ''}" 
            onclick="app.toggleFilter('free_shipping')">
            🚚 Gratis Ongkir
          </button>
          <button class="filter-pill featured ${appState.activeFilter === 'featured' ? 'active' : ''}" 
            onclick="app.toggleFilter('featured')">
            🔥 Produk Unggulan
          </button>
          ${appState.activeFilter ? `
            <button class="filter-pill" onclick="app.clearFilter()" style="border-style:dashed;">
              ✖ Reset Filter
            </button>
          ` : ''}
        </div>

        <!-- Category Slider -->
        <div class="category-slider">
          ${appState.categories.map(cat => `
            <button class="cat-chip ${appState.activeCategory === cat ? 'active' : ''}" 
              onclick="app.selectCategory('${cat}')">
              ${cat}
            </button>
          `).join('')}
        </div>
      </section>

      <!-- Main Catalog Grid (PRD 23.1 & Update 5) -->
      <section>
        <div class="section-header">
          <div class="section-title">
            🛒 Katalog Produk (${appState.products.length} Item)
          </div>
          <div class="section-subtitle">
            ${st.name} • Jam Buka: ${st.operating_hours || '07:00 - 22:00'}
          </div>
        </div>

        ${appState.products.length === 0 ? `
          <div style="text-align:center; padding:50px 20px; background:white; border-radius:var(--radius-lg); border:1px dashed var(--border-color);">
            <div style="font-size:2rem; margin-bottom:10px;">🔍</div>
            <div style="font-weight:700; color:var(--text-main);">Tidak ada produk yang cocok</div>
            <div style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">Coba gunakan kata kunci lain atau reset filter Anda.</div>
            <button class="btn-topup-cash" onclick="app.clearFilter()" style="margin-top:14px;">Reset Filter</button>
          </div>
        ` : `
          <div class="product-grid">
            ${appState.products.map(p => this.renderProductCardHtml(p)).join('')}
          </div>
        `}
      </section>
    `;
  },

  /* =========================================================================
     UPDATE 5: MULTI-PHOTO CARD WITH NUMBERED BADGES (1, 2, 3...) & AUTO-SLIDE
     ========================================================================= */
  renderProductCardHtml(p) {
    const images = Array.isArray(p.images) ? p.images : (JSON.parse(p.images_json || '[]'));
    const coverImg = images[0] || '/assets/promo_banner_1.jpg';
    const isWishlisted = appState.wishlist.includes(p.id);

    return `
      <article class="product-card" id="card-${p.id}" data-prod-id="${p.id}" data-images='${JSON.stringify(images).replace(/'/g, "&apos;")}' data-current-img="0">
        <!-- Image & Badges -->
        <div class="product-card-img-wrap" onclick="app.openProductModal('${p.id}')">
          <img id="card-img-${p.id}" src="${coverImg}" alt="${p.name}" loading="lazy">

          <div class="product-badge-stack">
            ${p.is_discount ? `<span class="card-badge discount">DISKON</span>` : ''}
            ${p.is_featured ? `<span class="card-badge featured">UNGGULAN</span>` : ''}
            ${p.is_free_shipping ? `<span class="card-badge free-shipping">BEBAS ONGKIR</span>` : ''}
          </div>

          <!-- Numbered Badges 1, 2, 3... (Update 5) -->
          ${images.length > 1 ? `
            <div class="card-photo-pills" id="pills-${p.id}">
              ${images.map((_, idx) => `
                <div class="card-photo-pill ${idx === 0 ? 'active' : ''}" 
                  id="pill-${p.id}-${idx}"
                  onclick="event.stopPropagation(); app.switchCardPhoto('${p.id}', ${idx})" 
                  title="Foto ${idx + 1}">
                  ${idx + 1}
                </div>
              `).join('')}
            </div>
          ` : ''}

          <!-- Quick Zoom Button (Addendum 23.1) -->
          <button class="zoom-trigger-btn" onclick="event.stopPropagation(); app.openProductModal('${p.id}', true)" title="Perbesar Foto" aria-label="Zoom Foto">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="11" y1="8" x2="11" y2="14"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
          </button>
        </div>

        <div class="product-card-body">
          <div class="product-category-text">${p.category}</div>
          <h3 class="product-name-title" onclick="app.openProductModal('${p.id}')">${p.name}</h3>

          <div class="product-meta-row">
            <span class="product-stock ${p.stock < 10 ? 'warning' : ''}">
              ${p.stock > 0 ? `Stok: ${p.stock} ${p.unit || ''}` : 'Stok Habis'}
            </span>
            <span>${p.sold_count || 0} Terjual</span>
          </div>

          <!-- Price & Bold Red Strike-through Old Price (Addendum 23.1) -->
          <div class="product-price-section">
            <span class="active-price">${formatRupiah(p.price)}</span>
            ${p.old_price && p.old_price > p.price ? `
              <span class="old-strike-price">${formatRupiah(p.old_price)}</span>
            ` : ''}
          </div>

          <!-- Action Add to Cart -->
          <button class="btn-add-cart" onclick="app.addToCart('${p.id}')">
            <span>+ Keranjang</span>
          </button>
        </div>
      </article>
    `;
  },

  startProductCardAutoSlide() {
    if (this.productSlideInterval) clearInterval(this.productSlideInterval);
    this.productSlideInterval = setInterval(() => {
      const cards = document.querySelectorAll('.product-card[data-images]');
      cards.forEach(card => {
        try {
          const imagesStr = card.getAttribute('data-images');
          if (!imagesStr) return;
          const images = JSON.parse(imagesStr);
          if (!images || images.length <= 1) return;

          const prodId = card.getAttribute('data-prod-id');
          let current = parseInt(card.getAttribute('data-current-img') || '0');
          let next = (current + 1) % images.length;
          card.setAttribute('data-current-img', next);

          const imgEl = document.getElementById(`card-img-${prodId}`);
          if (imgEl && images[next]) {
            imgEl.src = images[next];
          }

          images.forEach((_, idx) => {
            const pill = document.getElementById(`pill-${prodId}-${idx}`);
            if (pill) {
              pill.classList.toggle('active', idx === next);
            }
          });
        } catch (e) {}
      });
    }, 3200); // Auto-slide every 3.2 seconds
  },

  switchCardPhoto(prodId, targetIdx) {
    const card = document.getElementById(`card-${prodId}`);
    if (!card) return;
    try {
      const images = JSON.parse(card.getAttribute('data-images') || '[]');
      if (!images[targetIdx]) return;
      card.setAttribute('data-current-img', targetIdx);
      const imgEl = document.getElementById(`card-img-${prodId}`);
      if (imgEl) imgEl.src = images[targetIdx];

      images.forEach((_, idx) => {
        const pill = document.getElementById(`pill-${prodId}-${idx}`);
        if (pill) {
          pill.classList.toggle('active', idx === targetIdx);
        }
      });
    } catch (e) {}
  },

  handleSearchInput(val) {
    appState.searchQuery = val;
    this.loadCatalog().then(() => {
      this.render();
      const el = document.getElementById('catalog-search');
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  },

  handleSortChange(val) {
    appState.activeSort = val;
    this.refreshCatalog();
  },

  toggleFilter(filterName) {
    appState.activeFilter = (appState.activeFilter === filterName) ? null : filterName;
    this.refreshCatalog();
  },

  clearFilter() {
    appState.activeFilter = null;
    appState.searchQuery = '';
    appState.activeCategory = 'Semua';
    this.refreshCatalog();
  },

  selectCategory(cat) {
    appState.activeCategory = cat;
    this.refreshCatalog();
  },

  // Carousel Controller
  carouselIndex: 0,
  moveCarousel(step) {
    const slides = document.querySelectorAll('.carousel-slide');
    if (!slides.length) return;
    this.carouselIndex = (this.carouselIndex + step + slides.length) % slides.length;
    this.updateCarouselView();
  },

  setCarouselSlide(idx) {
    this.carouselIndex = idx;
    this.updateCarouselView();
  },

  updateCarouselView() {
    const slides = document.querySelectorAll('.carousel-slide');
    const dots = document.querySelectorAll('.indicator-dot');
    slides.forEach((sl, i) => {
      sl.classList.toggle('active', i === this.carouselIndex);
    });
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === this.carouselIndex);
    });
  },

  /* =========================================================================
     2. PRODUCT DETAIL, MULTI-PHOTO CAROUSEL & ZOOM MODAL (Addendum 22.6 & 23.3)
     ========================================================================= */
  currentModalProduct: null,
  currentPhotoIndex: 0,
  currentZoomScale: 1,

  openProductModal(productId, startWithZoom = false) {
    const prod = appState.products.find(p => p.id === productId);
    if (!prod) return;

    this.currentModalProduct = prod;
    this.currentPhotoIndex = 0;
    this.currentZoomScale = startWithZoom ? 1.5 : 1;

    const images = Array.isArray(prod.images) ? prod.images : JSON.parse(prod.images_json || '[]');
    const container = document.getElementById('modal-container');

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" onclick="event.stopPropagation()">
          <button class="modal-close-btn" onclick="app.closeModal()" aria-label="Tutup">✕</button>

          <!-- Zoom & Multi-Photo Viewport -->
          <div class="gallery-zoom-viewport" id="zoom-viewport">
            <!-- Numbered Indicator (Addendum 23.3 & Update 5) -->
            <div class="gallery-counter-badge" id="gallery-counter">
              Foto ${this.currentPhotoIndex + 1} dari ${images.length}
            </div>

            <!-- Numbered Buttons 1, 2, 3... in Modal -->
            ${images.length > 1 ? `
              <div class="card-photo-pills" style="top:12px; right:50px; bottom:auto;">
                ${images.map((_, idx) => `
                  <div class="card-photo-pill ${idx === 0 ? 'active' : ''}" id="modal-pill-${idx}" onclick="app.setPhotoIndex(${idx})">
                    ${idx + 1}
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <img id="gallery-img" src="${images[this.currentPhotoIndex]}" 
              alt="${prod.name}" 
              class="gallery-zoom-img" 
              style="transform: scale(${this.currentZoomScale});">

            <!-- Manual Previous / Next Buttons -->
            ${images.length > 1 ? `
              <button class="gallery-nav-btn prev" onclick="app.navPhoto(-1)">‹</button>
              <button class="gallery-nav-btn next" onclick="app.navPhoto(1)">›</button>
            ` : ''}

            <!-- Floating Zoom Controls -->
            <div class="zoom-controls-floating">
              <button class="zoom-ctrl-btn" onclick="app.adjustZoom(-0.25)" title="Perkecil">−</button>
              <button class="zoom-ctrl-btn" onclick="app.adjustZoom(0.25)" title="Perbesar">+</button>
              <button class="zoom-ctrl-btn" onclick="app.resetZoom()" title="Reset Ukuran" style="font-size:0.75rem;">1:1</button>
            </div>
          </div>

          <!-- Product Details Body -->
          <div class="modal-product-details">
            <div class="modal-product-header">
              <div>
                <div class="product-category-text">${prod.category} • SKU: ${prod.sku}</div>
                <h2 class="modal-product-title">${prod.name}</h2>
              </div>
              <div style="text-align:right;">
                <div class="modal-product-price">${formatRupiah(prod.price)}</div>
                ${prod.old_price ? `
                  <div class="old-strike-price">${formatRupiah(prod.old_price)}</div>
                ` : ''}
              </div>
            </div>

            <div class="modal-product-desc">
              ${prod.description || 'Produk minimarket segar dan berkualitas terjamin.'}
            </div>

            <div style="display:flex; gap:16px; font-size:0.8rem; color:var(--text-muted); margin-bottom:16px;">
              <span>📦 Stok Tersedia: <strong>${prod.stock} ${prod.unit}</strong></span>
              <span>🔥 Terjual: <strong>${prod.sold_count} kali</strong></span>
              ${prod.is_free_shipping ? '<span style="color:var(--success); font-weight:700;">🚚 Bebas Ongkir</span>' : ''}
            </div>

            <!-- Action Bar with Stepper and "Pesan Sekarang" button always visible (Addendum 22.6) -->
            <div class="modal-product-action-bar">
              <div class="qty-stepper">
                <button class="qty-btn" onclick="app.changeModalQty(-1)">−</button>
                <span class="qty-display" id="modal-qty-display">1</span>
                <button class="qty-btn" onclick="app.changeModalQty(1)">+</button>
              </div>

              <button class="btn-order-now" onclick="app.orderNowFromModal('${prod.id}')">
                <span>🛒 Pesan Sekarang</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  modalQty: 1,
  changeModalQty(delta) {
    this.modalQty = Math.max(1, this.modalQty + delta);
    const el = document.getElementById('modal-qty-display');
    if (el) el.textContent = this.modalQty;
  },

  setPhotoIndex(idx) {
    if (!this.currentModalProduct) return;
    const images = Array.isArray(this.currentModalProduct.images) ? 
      this.currentModalProduct.images : JSON.parse(this.currentModalProduct.images_json || '[]');
    if (!images[idx]) return;

    this.currentPhotoIndex = idx;
    const imgEl = document.getElementById('gallery-img');
    const counterEl = document.getElementById('gallery-counter');
    if (imgEl && counterEl) {
      imgEl.src = images[this.currentPhotoIndex];
      counterEl.textContent = `Foto ${this.currentPhotoIndex + 1} dari ${images.length}`;
    }
    images.forEach((_, i) => {
      const p = document.getElementById(`modal-pill-${i}`);
      if (p) p.classList.toggle('active', i === idx);
    });
  },

  navPhoto(step) {
    if (!this.currentModalProduct) return;
    const images = Array.isArray(this.currentModalProduct.images) ? 
      this.currentModalProduct.images : JSON.parse(this.currentModalProduct.images_json || '[]');
    
    const nextIdx = (this.currentPhotoIndex + step + images.length) % images.length;
    this.setPhotoIndex(nextIdx);
  },

  adjustZoom(delta) {
    this.currentZoomScale = Math.max(1, Math.min(3, this.currentZoomScale + delta));
    const imgEl = document.getElementById('gallery-img');
    if (imgEl) {
      imgEl.style.transform = `scale(${this.currentZoomScale})`;
    }
  },

  resetZoom() {
    this.currentZoomScale = 1;
    const imgEl = document.getElementById('gallery-img');
    if (imgEl) {
      imgEl.style.transform = `scale(1)`;
    }
  },

  orderNowFromModal(prodId) {
    this.addToCart(prodId, this.modalQty);
    this.closeModal();
    this.openCartDrawer();
  },

  closeModal(event) {
    if (event && event.target && !event.target.classList.contains('modal-overlay') && !event.target.classList.contains('modal-close-btn')) {
      return;
    }
    document.getElementById('modal-container').innerHTML = '';
  },

  /* =========================================================================
     3. CART, PER-ITEM NOTES & CHECKOUT (Addendum 22.4 & 24.1)
     ========================================================================= */
  addToCart(productId, qty = 1) {
    const prod = appState.products.find(p => p.id === productId);
    if (!prod) return;

    if (prod.stock <= 0) {
      alert('Maaf, stok produk ini sedang habis.');
      return;
    }

    const existing = appState.cart.find(it => it.product.id === productId);
    if (existing) {
      existing.quantity += qty;
    } else {
      appState.cart.push({
        product: prod,
        quantity: qty,
        item_note: '' // Catatan per item (Addendum 24.1)
      });
    }

    this.updateFloatingCartBar();
  },

  updateFloatingCartBar() {
    const bar = document.getElementById('floating-cart-bar');
    const countBadge = document.getElementById('floating-cart-count');
    const headerCartBadge = document.getElementById('header-cart-badge');
    const itemsText = document.getElementById('floating-cart-items-text');
    const totalEl = document.getElementById('floating-cart-total');

    const totalQty = appState.cart.reduce((sum, it) => sum + it.quantity, 0);
    const subtotal = appState.cart.reduce((sum, it) => sum + (it.product.price * it.quantity), 0);

    if (totalQty > 0 && appState.currentRole === 'consumer') {
      bar.style.display = 'flex';
      countBadge.textContent = totalQty;
      headerCartBadge.style.display = 'flex';
      headerCartBadge.textContent = totalQty;
      itemsText.textContent = `${totalQty} Produk dari ${appState.stores.find(s=>s.id===appState.currentStoreId)?.name || 'Toko'}`;
      totalEl.textContent = formatRupiah(subtotal);
    } else {
      bar.style.display = 'none';
      headerCartBadge.style.display = 'none';
    }
  },

  openCartDrawer() {
    const container = document.getElementById('cart-drawer-container');
    const st = appState.stores.find(s => s.id === appState.currentStoreId) || {};
    const u = appState.currentUser || {};
    const addresses = u.addresses || [];

    const subtotal = appState.cart.reduce((sum, it) => sum + (it.product.price * it.quantity), 0);
    const hasFreeShipping = appState.cart.some(it => it.product.is_free_shipping) || subtotal >= 100000;
    const baseFare = st.base_fare || 8000;
    const distanceKm = 2.8;
    const calculatedDelivery = hasFreeShipping ? 0 : (baseFare + Math.round(distanceKm * (st.per_km_fare || 2500)));
    const total = subtotal + calculatedDelivery;

    container.innerHTML = `
      <div class="drawer-overlay" onclick="app.closeCartDrawer(event)">
        <div class="drawer-panel" onclick="event.stopPropagation()">
          <div class="drawer-header">
            <div class="drawer-title">
              <span>🛒 Keranjang Belanja</span>
            </div>
            <button class="modal-close-btn" onclick="app.closeCartDrawer()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>

          <div class="drawer-body">
            <!-- Store banner -->
            <div style="background:#f1f5f9; padding:10px 14px; border-radius:var(--radius-md); font-size:0.8rem; margin-bottom:16px;">
              <strong>Toko Pemenuhan:</strong> ${st.name} (${st.operating_hours || 'Buka'})
            </div>

            <!-- Cart Items List -->
            ${appState.cart.length === 0 ? `
              <div style="text-align:center; padding:40px 10px; color:var(--text-muted);">
                <div style="font-size:2.5rem; margin-bottom:10px;">🛒</div>
                <div style="font-weight:700;">Keranjang Anda masih kosong</div>
                <div style="font-size:0.8rem; margin-top:4px;">Ayo pilih produk minimarket favorit Anda sekarang!</div>
              </div>
            ` : appState.cart.map((it, idx) => {
              const img = Array.isArray(it.product.images) ? it.product.images[0] : JSON.parse(it.product.images_json || '[]')[0];
              return `
                <div class="cart-item-row">
                  <img src="${img || '/assets/promo_banner_1.jpg'}" alt="${it.product.name}" class="cart-item-img">
                  <div class="cart-item-details">
                    <div class="cart-item-title">${it.product.name}</div>
                    <div class="cart-item-price">${formatRupiah(it.product.price)}</div>

                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <div class="qty-stepper" style="height:30px;">
                        <button class="qty-btn" onclick="app.updateCartQty(${idx}, -1)">−</button>
                        <span class="qty-display" style="font-size:0.85rem;">${it.quantity}</span>
                        <button class="qty-btn" onclick="app.updateCartQty(${idx}, 1)">+</button>
                      </div>
                      <span style="font-weight:800; font-size:0.9rem; color:var(--primary);">
                        ${formatRupiah(it.product.price * it.quantity)}
                      </span>
                    </div>

                    <!-- Per-Item Note (Addendum 24.1) -->
                    <input type="text" class="cart-item-note-input" 
                      placeholder="Catatan untuk item ini (misal: pilih exp lama / matang)..." 
                      value="${it.item_note || ''}" 
                      onchange="app.updateItemNote(${idx}, this.value)">
                  </div>
                </div>
              `;
            }).join('')}

            ${appState.cart.length > 0 ? `
              <!-- Delivery Address Selection -->
              <div class="form-group" style="margin-top:20px;">
                <label class="form-label">📍 Alamat Pengantaran</label>
                <select class="form-select" id="checkout-address-select">
                  ${addresses.length > 0 ? addresses.map(a => `
                    <option value="${a.address_text}">${a.label}: ${a.address_text}</option>
                  `).join('') : '<option value="Jl. Bangka II No. 18, Mampang Prapatan">Rumah: Jl. Bangka II No. 18, Mampang Prapatan</option>'}
                </select>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">
                  Estimasi Jarak Pengantaran: <strong>${distanceKm} km</strong> dari toko.
                </div>
              </div>

              <!-- General Order Note -->
              <div class="form-group">
                <label class="form-label">📝 Catatan Tambahan Pesanan (Opsional)</label>
                <input type="text" id="checkout-order-note" class="form-input" placeholder="Contoh: Titip di teras samping dekat pintu...">
              </div>

              <!-- Payment Method Selection -->
              <div class="form-group">
                <label class="form-label">💳 Metode Pembayaran</label>
                <select class="form-select" id="checkout-payment-method">
                  <option value="Saldo CS Pay">Saldo CS Pay (${formatRupiah(u.wallet_balance || 0)})</option>
                  <option value="QRIS CS Mart (Simulasi)">QRIS (GoPay, OVO, ShopeePay)</option>
                  <option value="Virtual Account (Simulasi)">Virtual Account (BCA, Mandiri, BRI)</option>
                  <option value="Tunai di Tempat (COD)">Tunai Saat Serah Terima (COD)</option>
                </select>
              </div>

              <!-- Price Breakdown -->
              <div class="order-summary-box">
                <div class="summary-line">
                  <span>Subtotal Produk</span>
                  <span>${formatRupiah(subtotal)}</span>
                </div>
                <div class="summary-line">
                  <span>Ongkos Kirim (${distanceKm} km)</span>
                  <span>${hasFreeShipping ? '<span style="color:var(--success); font-weight:700;">GRATIS</span>' : formatRupiah(calculatedDelivery)}</span>
                </div>
                <div class="summary-line total">
                  <span>Total Pembayaran</span>
                  <span>${formatRupiah(total)}</span>
                </div>
              </div>
            ` : ''}
          </div>

          ${appState.cart.length > 0 ? `
            <div class="drawer-footer">
              <button class="btn-checkout-submit" onclick="app.submitCheckout()">
                <span>Bayar Sekarang (${formatRupiah(total)})</span>
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  updateCartQty(idx, delta) {
    if (!appState.cart[idx]) return;
    appState.cart[idx].quantity += delta;
    if (appState.cart[idx].quantity <= 0) {
      appState.cart.splice(idx, 1);
    }
    this.updateFloatingCartBar();
    this.openCartDrawer();
  },

  updateItemNote(idx, note) {
    if (appState.cart[idx]) {
      appState.cart[idx].item_note = note;
    }
  },

  closeCartDrawer(event) {
    if (event && event.target && !event.target.classList.contains('drawer-overlay')) {
      return;
    }
    document.getElementById('cart-drawer-container').innerHTML = '';
  },

  async submitCheckout() {
    if (appState.isOffline) {
      alert('Maaf, pemesanan dan checkout memerlukan koneksi internet aktif untuk validasi server.');
      return;
    }

    if (!appState.currentUser) {
      alert('Silakan login terlebih dahulu untuk melanjutkan checkout.');
      this.openLoginModal();
      return;
    }

    if (appState.cart.length === 0) return;

    const addressSelect = document.getElementById('checkout-address-select');
    const noteInput = document.getElementById('checkout-order-note');
    const paymentSelect = document.getElementById('checkout-payment-method');

    const payload = {
      user_id: appState.currentUser.id,
      store_id: appState.currentStoreId,
      items: appState.cart.map(it => ({
        product_id: it.product.id,
        quantity: it.quantity,
        item_note: it.item_note
      })),
      payment_method: paymentSelect ? paymentSelect.value : 'Saldo CS Pay',
      address_text: addressSelect ? addressSelect.value : 'Alamat Pengantaran',
      order_notes: noteInput ? noteInput.value : '',
      distance_km: 2.8
    };

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Terjadi kesalahan saat memproses pesanan.');
        return;
      }

      // Success
      appState.cart = [];
      this.updateFloatingCartBar();
      this.closeCartDrawer();
      await this.fetchUserProfile(appState.currentUser.id); // update balance
      await this.loadCatalog(); // update stock

      // Add notification
      this.addNotification(`Pesanan Diterima!`, `Pesanan ${data.order_id} berhasil dibuat. Toko mulai menyiapkan pesanan Anda.`);

      // Open Order Tracker
      this.openOrderTracker(data.order_id);
    } catch (err) {
      alert('Gagal menghubungi server: ' + err.message);
    }
  },

  /* =========================================================================
     4. ORDER TRACKING & 2-WAY COURIER CHAT (PRD 5.3 & Addendum 22.3)
     ========================================================================= */
  async openOrderTracker(orderId) {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      const data = await res.json();
      if (!data.order) return;
      const order = data.order;
      appState.activeOrder = order;

      const container = document.getElementById('modal-container');
      const store = order.store || {};
      const courier = order.courier || {};

      const statusMap = {
        'pending_payment': 'Menunggu Pembayaran',
        'paid': 'Pembayaran Dikonfirmasi',
        'processing': 'Toko Menyiapkan Barang',
        'packed': 'Barang Telah Dikemas',
        'awaiting_courier': 'Menunggu Penugasan Kurir',
        'assigned': 'Kurir Ditugaskan',
        'picked_up': 'Pesanan Diambil Kurir',
        'in_transit': 'Dalam Perjalanan Menuju Alamat',
        'delivered': 'Barang Telah Sampai / Diserahkan',
        'completed': 'Pesanan Selesai',
        'complaint': 'Dalam Penanganan Komplain',
        'refunded': 'Dana Telah Direfund'
      };

      container.innerHTML = `
        <div class="modal-overlay" onclick="app.closeOrderTracker(event)">
          <div class="modal-content-card" style="max-width: 620px;" onclick="event.stopPropagation()">
            <div class="drawer-header" style="border-radius: var(--radius-lg) var(--radius-lg) 0 0;">
              <div>
                <div style="font-size:0.75rem; color:#cbd5e1;">Pelacakan Langsung</div>
                <div class="drawer-title">Pesanan: ${order.id}</div>
              </div>
              <button class="modal-close-btn" onclick="app.closeOrderTracker()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
            </div>

            <div style="padding:20px;">
              <!-- Current Status Banner -->
              <div style="background:linear-gradient(90deg, #090765, #18158c); color:white; padding:14px; border-radius:var(--radius-md); margin-bottom:16px;">
                <div style="font-size:0.72rem; color:#fde047; font-weight:700; text-transform:uppercase;">Status Pesanan Saat Ini</div>
                <div style="font-size:1.15rem; font-weight:800; margin:2px 0;">
                  ${statusMap[order.status] || order.status}
                </div>
                <div style="font-size:0.78rem; opacity:0.85;">
                  Toko: ${store.name || 'CS Mart'} • Total: ${formatRupiah(order.total_amount)}
                </div>
              </div>

              <!-- Interactive Simulated Live Map for Courier Route -->
              <div style="position:relative; background:#e2e8f0; border-radius:var(--radius-md); height:160px; overflow:hidden; margin-bottom:20px; border:1px solid #cbd5e1;">
                <div style="position:absolute; inset:0; background:repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 10px, #f1f5f9 10px, #f1f5f9 20px); opacity:0.6;"></div>
                
                <!-- Store Pin -->
                <div style="position:absolute; top:25px; left:30px; display:flex; align-items:center; gap:6px; background:white; padding:4px 8px; border-radius:var(--radius-full); box-shadow:var(--shadow-sm); font-size:0.75rem; font-weight:700;">
                  🏪 Toko CS Mart
                </div>

                <!-- Destination Pin -->
                <div style="position:absolute; bottom:25px; right:30px; display:flex; align-items:center; gap:6px; background:white; padding:4px 8px; border-radius:var(--radius-full); box-shadow:var(--shadow-sm); font-size:0.75rem; font-weight:700;">
                  🏠 Alamat Tujuan
                </div>

                <!-- Animated Courier Icon -->
                <div id="sim-courier-pin" style="position:absolute; top:${order.status === 'in_transit' ? '50%' : (order.status === 'delivered' || order.status === 'completed' ? '70%' : '30%')}; left:${order.status === 'in_transit' ? '50%' : (order.status === 'delivered' || order.status === 'completed' ? '75%' : '35%')}; transform:translate(-50%, -50%); background:#090765; color:#dbc911; padding:6px 12px; border-radius:var(--radius-full); font-size:0.78rem; font-weight:800; box-shadow:var(--shadow-lg); transition: all 1s ease; border:2px solid #dbc911;">
                  🛵 Kurir ${courier.name ? courier.name.split(' ')[0] : 'CS Mart'}
                </div>
              </div>

              <!-- 2-Way Chat with Courier (Addendum 22.3) -->
              ${order.courier_id ? `
                <div style="margin-bottom:20px;">
                  <div class="section-title" style="font-size:0.95rem;">
                    💬 Chat dengan Kurir (${courier.name || 'Budi Santoso'})
                  </div>
                  <div class="chat-container">
                    <div class="chat-messages" id="chat-messages-box">
                      ${order.chats && order.chats.length > 0 ? order.chats.map(ch => `
                        <div class="chat-bubble ${ch.sender_role === appState.currentRole ? 'mine' : 'theirs'}">
                          <div style="font-size:0.7rem; font-weight:700; margin-bottom:2px;">${ch.sender_name}</div>
                          <div>${ch.message}</div>
                          <div class="chat-meta">${new Date(ch.created_at).toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' })}</div>
                        </div>
                      `).join('') : `
                        <div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.8rem;">
                          Belum ada pesan. Anda dapat chat dengan kurir mengenai petunjuk pengantaran.
                        </div>
                      `}
                    </div>
                    <div class="chat-input-bar">
                      <input type="text" id="order-chat-input" class="chat-input" placeholder="Tulis pesan ke kurir...">
                      <button class="chat-send-btn" onclick="app.sendChatMessage('${order.id}')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="22" y1="2" x2="11" y2="13"></line>
                          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ` : `
                <div style="background:#f8fafc; border:1px dashed var(--border-color); padding:12px; border-radius:var(--radius-md); font-size:0.8rem; color:var(--text-muted); margin-bottom:16px;">
                  ℹ️ Chat kurir akan terbuka otomatis setelah toko menugaskan kurir untuk pengantaran pesanan ini.
                </div>
              `}

              <!-- Timeline of Events -->
              <div class="section-title" style="font-size:0.95rem; margin-bottom:10px;">
                📜 Riwayat Status Pesanan
              </div>
              <div class="tracking-timeline">
                ${order.timeline ? order.timeline.map(ev => `
                  <div class="timeline-step completed">
                    <div class="timeline-title">${statusMap[ev.status] || ev.status}</div>
                    <div class="timeline-meta">Oleh: ${ev.actor} • ${new Date(ev.created_at).toLocaleString('id-ID')}</div>
                    ${ev.note ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${ev.note}</div>` : ''}
                  </div>
                `).join('') : ''}
              </div>

              <!-- Customer Actions: Finish Order, Complaint, or Review -->
              <div style="margin-top:20px; display:flex; gap:10px; flex-wrap:wrap;">
                ${order.status === 'delivered' ? `
                  <button class="btn-checkout-submit" style="background:var(--success); flex:1;" onclick="app.confirmOrderDelivered('${order.id}')">
                    ✓ Konfirmasi Pesanan Diterima
                  </button>
                ` : ''}

                ${order.status === 'completed' && !order.review ? `
                  <button class="btn-checkout-submit" style="background:#090765; flex:1;" onclick="app.openReviewModal('${order.id}')">
                    ⭐ Beri Ulasan & Rating
                  </button>
                ` : ''}

                ${['delivered', 'completed'].includes(order.status) && !order.complaint ? `
                  <button class="btn-topup-cash" style="background:#fee2e2; color:#b91c1c; padding:10px 16px; border:1px solid #fca5a5;" onclick="app.openComplaintModal('${order.id}')">
                    ⚠️ Ajukan Komplain / Refund
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      `;

      // Scroll chat to bottom
      const chatBox = document.getElementById('chat-messages-box');
      if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
    } catch (err) {
      console.error(err);
    }
  },

  closeOrderTracker(event) {
    if (event && event.target && !event.target.classList.contains('modal-overlay')) return;
    document.getElementById('modal-container').innerHTML = '';
  },

  async sendChatMessage(orderId) {
    const input = document.getElementById('order-chat-input');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    try {
      const res = await fetch('/api/orders/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          sender_id: appState.currentUser.id,
          sender_role: appState.currentRole,
          message: message
        })
      });
      if (res.ok) {
        this.openOrderTracker(orderId);
      }
    } catch (err) {
      console.warn('Chat error', err);
    }
  },

  async confirmOrderDelivered(orderId) {
    if (!confirm('Apakah Anda yakin pesanan telah diterima dengan baik? Poin loyalitas akan dikreditkan ke akun Anda.')) return;

    try {
      const res = await fetch('/api/orders/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          status: 'completed',
          actor_id: appState.currentUser.id,
          actor_role: 'consumer',
          note: 'Pesanan telah diterima dan diselesaikan oleh konsumen'
        })
      });
      if (res.ok) {
        alert('Terima kasih! Pesanan selesai dan poin loyalty telah ditambahkan ke akun Anda.');
        await this.fetchUserProfile(appState.currentUser.id);
        this.openOrderTracker(orderId);
        this.render();
      }
    } catch (err) {
      alert('Gagal menyelesaikan pesanan: ' + err.message);
    }
  },

  /* =========================================================================
     5. CASH TOP-UP FLOW (PRD Addendum 24.2)
     ========================================================================= */
  openCashTopupModal() {
    const u = appState.currentUser;
    const st = appState.stores.find(s => s.id === appState.currentStoreId) || {};
    const container = document.getElementById('modal-container');

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width: 440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius: var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">💵 Top Up Tunai di Kasir</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>

          <div style="padding: 20px;">
            <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:14px;">
              Pilih nominal top up, lalu tunjukkan kode referensi ke kasir <strong>${st.name}</strong> untuk membayar tunai.
            </div>

            <div class="form-group">
              <label class="form-label">Nominal Top Up</label>
              <select id="topup-amount-select" class="form-select">
                <option value="25000">Rp 25.000</option>
                <option value="50000" selected>Rp 50.000</option>
                <option value="100000">Rp 100.000</option>
                <option value="200000">Rp 200.000</option>
              </select>
            </div>

            <div id="topup-code-result" style="display:none; background:#f1f5f9; border:2px dashed #090765; border-radius:var(--radius-md); padding:16px; text-align:center; margin:16px 0;">
              <div style="font-size:0.75rem; color:var(--text-muted);">KODE REFERENSI KASIR:</div>
              <div id="generated-topup-code" style="font-size:1.4rem; font-weight:800; color:#090765; letter-spacing:1px; margin:6px 0;">
                TOPUP-KMG-0000
              </div>
              <div style="font-size:0.75rem; color:#d97706; font-weight:700;">
                Status: Menunggu Pembayaran Tunai di Kasir (pending_cash)
              </div>
              <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">
                Tunjukkan kode ini kepada petugas kasir minimarket untuk konfirmasi pembayaran tunai.
              </div>
            </div>

            <button id="btn-request-topup" class="btn-checkout-submit" onclick="app.submitCashTopupRequest()">
              Terbitkan Kode Top Up Kasir
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async submitCashTopupRequest() {
    const amount = document.getElementById('topup-amount-select').value;
    try {
      const res = await fetch('/api/wallet/topup/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: appState.currentUser.id,
          store_id: appState.currentStoreId,
          amount: parseInt(amount)
        })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('topup-code-result').style.display = 'block';
        document.getElementById('generated-topup-code').textContent = data.code;
        document.getElementById('btn-request-topup').style.display = 'none';

        this.addNotification('Kode Top Up Diterbitkan', `Kode ${data.code} sebesar ${formatRupiah(data.amount)} siap dibayar di kasir.`);
      }
    } catch (err) {
      alert('Gagal membuat permintaan top up: ' + err.message);
    }
  },

  /* =========================================================================
     6. INITIAL PROMO POPUP (PRD Addendum 25.2)
     ========================================================================= */
  checkInitialPromoPopup() {
    const dismissed = localStorage.getItem('cs_mart_popup_dismissed_v1');
    if (!dismissed) {
      setTimeout(() => {
        this.showPromoPopup();
      }, 1000);
    }
  },

  showPromoPopup() {
    const modalContainer = document.getElementById('modal-container');
    const existing = document.getElementById('promo-popup-card');
    if (existing) return;

    const popupHtml = `
      <div id="promo-popup-card" class="promo-popup-card" role="dialog" aria-modal="false">
        <button class="modal-close-btn" onclick="app.dismissPromoPopup()" style="top:10px; right:10px;">✕</button>
        <img src="/assets/promo_banner_1.jpg" alt="Promo Gajian CS Mart" class="promo-popup-img">
        <div class="promo-popup-body">
          <h2 class="promo-popup-title">🎉 Flash Sale CS Mart!</h2>
          <p class="promo-popup-content">
            Dapatkan promo diskon hingga 50% dan gratis ongkos kirim ke seluruh alamat pengantaran hari ini.
          </p>
          <div class="promo-popup-actions">
            <button class="btn-checkout-submit" onclick="app.dismissPromoPopup(true)" style="background:#090765;">
              Belanja Sekarang
            </button>
            <button class="filter-pill" onclick="app.dismissPromoPopup()" style="padding:10px 16px;">
              Nanti Saja
            </button>
          </div>
        </div>
      </div>
    `;
    modalContainer.insertAdjacentHTML('beforeend', popupHtml);
  },

  dismissPromoPopup(openPromoFilter = false) {
    const el = document.getElementById('promo-popup-card');
    if (el) el.remove();
    localStorage.setItem('cs_mart_popup_dismissed_v1', 'true');
    if (openPromoFilter) {
      this.toggleFilter('discount');
    }
  },

  /* =========================================================================
     7. STORE ADMIN PORTAL (PRD 3.2 & Addenda)
     ========================================================================= */
  renderStoreAdminView(container) {
    const u = appState.currentUser || {};
    const st = appState.stores.find(s => s.id === u.store_id) || appState.stores[0] || {};
    const tab = appState.adminActiveTab;

    container.innerHTML = `
      <div class="admin-layout">
        <!-- Sticky Sidebar Desktop (PRD 23.4) -->
        <aside class="admin-sidebar" aria-label="Menu Admin Toko">
          <div style="padding:4px 8px; margin-bottom:8px;">
            <div style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">PORTAL ADMIN TOKO</div>
            <div style="font-weight:800; color:var(--primary); font-size:0.95rem;">${st.name}</div>
          </div>

          <div class="sidebar-item ${tab === 'dashboard' ? 'active' : ''}" onclick="app.setAdminTab('dashboard')">
            <span>📊 Ringkasan & Omzet</span>
          </div>
          <div class="sidebar-item ${tab === 'orders' ? 'active' : ''}" onclick="app.setAdminTab('orders')">
            <span>📦 Kelola Pesanan</span>
          </div>
          <div class="sidebar-item ${tab === 'cashier' ? 'active' : ''}" onclick="app.setAdminTab('cashier')">
            <span>💵 Kasir Top Up Tunai</span>
          </div>
          <div class="sidebar-item ${tab === 'catalog' ? 'active' : ''}" onclick="app.setAdminTab('catalog')">
            <span>🏷️ Kelola Katalog & Foto</span>
          </div>
          <div class="sidebar-item ${tab === 'tiers' ? 'active' : ''}" onclick="app.setAdminTab('tiers')">
            <span>⭐ Aturan Tier Member</span>
          </div>
          <div class="sidebar-item ${tab === 'complaints' ? 'active' : ''}" onclick="app.setAdminTab('complaints')">
            <span>⚠️ Komplain & Refund</span>
          </div>
          <div class="sidebar-item ${tab === 'reports' ? 'active' : ''}" onclick="app.setAdminTab('reports')">
            <span>📜 Laporan & Audit</span>
          </div>
        </aside>

        <!-- Main Admin Content Area -->
        <section class="admin-main-panel" id="admin-main-content">
          <!-- Populated by admin tabs -->
        </section>
      </div>
    `;

    this.renderAdminTabContent(st.id);
  },

  setAdminTab(tabName) {
    appState.adminActiveTab = tabName;
    const u = appState.currentUser || {};
    this.renderAdminTabContent(u.store_id || 'store-kemang');
  },

  async renderAdminTabContent(storeId) {
    const panel = document.getElementById('admin-main-content');
    if (!panel) return;
    const tab = appState.adminActiveTab;

    if (tab === 'dashboard') {
      const res = await fetch(`/api/reports?store_id=${storeId}`);
      const data = await res.json();

      panel.innerHTML = `
        <div class="section-title">📊 Ringkasan Operasional & Omzet Toko</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:20px;">
          Metrik operasional toko harian, omzet kotor/bersih, dan pesanan yang memerlukan perhatian.
        </p>

        <div class="stats-cards-grid">
          <div class="stat-card-admin">
            <div class="stat-card-title">Total Omzet Penjualan</div>
            <div class="stat-card-number">${formatRupiah(data.total_gmv || 0)}</div>
          </div>
          <div class="stat-card-admin">
            <div class="stat-card-title">Total Pesanan Masuk</div>
            <div class="stat-card-number">${data.total_orders || 0}</div>
          </div>
          <div class="stat-card-admin">
            <div class="stat-card-title">Pesanan Berhasil</div>
            <div class="stat-card-number">${data.completed_orders || 0}</div>
          </div>
        </div>

        <div class="section-title" style="font-size:1rem; margin:24px 0 12px 0;">
          Status Pesanan Saat Ini
        </div>
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Jumlah Pesanan</th>
                <th>Nilai Transaksi</th>
              </tr>
            </thead>
            <tbody>
              ${data.status_summary ? data.status_summary.map(s => `
                <tr>
                  <td><strong>${s.status}</strong></td>
                  <td>${s.cnt}</td>
                  <td>${formatRupiah(s.gmv)}</td>
                </tr>
              `).join('') : ''}
            </tbody>
          </table>
        </div>
      `;
    } else if (tab === 'orders') {
      const res = await fetch(`/api/orders?store_id=${storeId}`);
      const data = await res.json();
      const orders = data.orders || [];

      panel.innerHTML = `
        <div class="section-title">📦 Pemrosesan Pesanan Toko</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:16px;">
          Terima pesanan, kemas barang, dan tugaskan kurir untuk pengantaran.
        </p>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>No. Pesanan</th>
                <th>Konsumen</th>
                <th>Total</th>
                <th>Status</th>
                <th>Waktu</th>
                <th>Tindakan Operasional</th>
              </tr>
            </thead>
            <tbody>
              ${orders.map(o => `
                <tr>
                  <td><strong>${o.id}</strong></td>
                  <td>${o.address_snapshot ? o.address_snapshot.slice(0, 20) + '...' : '-'}</td>
                  <td>${formatRupiah(o.total_amount)}</td>
                  <td><span class="role-tag" style="background:#f1f5f9; color:#090765;">${o.status}</span></td>
                  <td>${new Date(o.created_at).toLocaleTimeString('id-ID')}</td>
                  <td>
                    ${o.status === 'paid' ? `
                      <button class="btn-topup-cash" onclick="app.updateOrderStatus('${o.id}', 'processing')">
                        Proses Barang
                      </button>
                    ` : o.status === 'processing' ? `
                      <button class="btn-topup-cash" style="background:var(--primary); color:white;" onclick="app.updateOrderStatus('${o.id}', 'packed')">
                        Kemas Selesai
                      </button>
                    ` : o.status === 'packed' ? `
                      <button class="btn-topup-cash" style="background:var(--accent-red); color:white;" onclick="app.updateOrderStatus('${o.id}', 'assigned', 'usr-budi')">
                        Tugaskan Kurir Budi
                      </button>
                    ` : `
                      <button class="filter-pill" style="font-size:0.75rem; padding:3px 8px;" onclick="app.openOrderTracker('${o.id}')">
                        Lihat Detail
                      </button>
                    `}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (tab === 'cashier') {
      const res = await fetch(`/api/cashier/topups?store_id=${storeId}`);
      const data = await res.json();
      const topups = data.topups || [];

      panel.innerHTML = `
        <div class="section-title">💵 Kasir Top Up Tunai Minimarket</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:16px;">
          Verifikasi uang tunai yang diterima dari konsumen lalu konfirmasi untuk mengkreditkan saldo CS Pay secara instan.
        </p>

        <!-- Quick Code Input -->
        <div style="background:#f8fafc; border:1px solid var(--border-color); padding:16px; border-radius:var(--radius-md); margin-bottom:20px; display:flex; gap:10px; align-items:center;">
          <input type="text" id="cashier-manual-code" class="form-input" placeholder="Masukkan Kode Top Up (misal: TOPUP-KMG-9821)..." style="max-width:320px;">
          <button class="btn-checkout-submit" style="width:auto; padding:10px 20px; background:var(--primary);" onclick="app.confirmCashierTopup(document.getElementById('cashier-manual-code').value)">
            Verifikasi & Terima Tunai
          </button>
        </div>

        <div class="section-title" style="font-size:1rem; margin-bottom:10px;">Antrean Permintaan Top Up Tunai</div>
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Kode Referensi</th>
                <th>Konsumen</th>
                <th>Nominal</th>
                <th>Status</th>
                <th>Waktu</th>
                <th>Aksi Kasir</th>
              </tr>
            </thead>
            <tbody>
              ${topups.map(t => `
                <tr>
                  <td><strong>${t.code}</strong></td>
                  <td>${t.user_name} (${t.user_phone})</td>
                  <td><strong style="color:var(--primary);">${formatRupiah(t.amount)}</strong></td>
                  <td>
                    <span class="role-tag" style="background:${t.status === 'confirmed' ? '#dcfce7; color:#166534' : '#fef3c7; color:#92400e'}">
                      ${t.status}
                    </span>
                  </td>
                  <td>${new Date(t.created_at).toLocaleString('id-ID')}</td>
                  <td>
                    ${t.status === 'pending_cash' ? `
                      <button class="btn-topup-cash" onclick="app.confirmCashierTopup('${t.code}')">
                        ✓ Terima Tunai
                      </button>
                    ` : `<span style="font-size:0.75rem; color:var(--text-muted);">Dikonfirmasi: ${t.confirmed_by}</span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (tab === 'catalog') {
      const res = await fetch(`/api/products?store_id=${storeId}`);
      const data = await res.json();
      const products = data.products || [];

      panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <div>
            <div class="section-title">🏷️ Kelola Katalog & Foto Produk</div>
            <div style="font-size:0.82rem; color:var(--text-muted);">Tambah, edit stok/harga, dan upload foto ke folder sistem.</div>
          </div>
          <button class="btn-checkout-submit" style="width:auto; padding:8px 16px; background:var(--primary);" onclick="app.openAdminProductModal()">
            + Tambah Produk Baru
          </button>
        </div>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Foto</th>
                <th>SKU</th>
                <th>Nama Produk</th>
                <th>Kategori</th>
                <th>Harga</th>
                <th>Stok</th>
                <th>Status Tag</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              ${products.map(p => `
                <tr>
                  <td><img src="${p.images[0] || '/assets/promo_banner_1.jpg'}" style="width:36px; height:36px; object-fit:cover; border-radius:4px;"></td>
                  <td>${p.sku}</td>
                  <td><strong>${p.name}</strong></td>
                  <td>${p.category}</td>
                  <td>${formatRupiah(p.price)}</td>
                  <td>${p.stock}</td>
                  <td>
                    ${p.is_discount ? '<span class="card-badge discount">Diskon</span> ' : ''}
                    ${p.is_featured ? '<span class="card-badge featured">Unggulan</span> ' : ''}
                    ${p.is_free_shipping ? '<span class="card-badge free-shipping">Gratis Ongkir</span>' : ''}
                  </td>
                  <td>
                    <button class="filter-pill" style="font-size:0.75rem; padding:3px 8px;" onclick="app.openAdminProductModal('${p.id}')">Edit</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (tab === 'tiers') {
      const res = await fetch(`/api/tier-settings?store_id=${storeId}`);
      const data = await res.json();
      const ts = data.tier_settings || {};

      panel.innerHTML = `
        <div class="section-title">⭐ Pengaturan Tier Member (Addendum 22.2)</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:20px;">
          Atur batas minimum total belanja untuk tier Silver, Gold, dan Platinum serta periode evaluasi berjalan.
        </p>

        <div style="max-width:480px; display:flex; flex-direction:column; gap:14px;">
          <div class="form-group">
            <label class="form-label">Batas Minimal Belanja Tier Gold (Rp)</label>
            <input type="number" id="tier-gold-input" class="form-input" value="${ts.gold_min || 500000}">
          </div>
          <div class="form-group">
            <label class="form-label">Batas Minimal Belanja Tier Platinum (Rp)</label>
            <input type="number" id="tier-plat-input" class="form-input" value="${ts.platinum_min || 1500000}">
          </div>
          <div class="form-group">
            <label class="form-label">Periode Evaluasi Belanja (Bulan)</label>
            <input type="number" id="tier-eval-input" class="form-input" value="${ts.evaluation_months || 12}">
          </div>

          <button class="btn-checkout-submit" style="background:var(--primary);" onclick="app.saveTierSettings()">
            Simpan Perubahan Aturan Tier
          </button>
        </div>
      `;
    } else if (tab === 'complaints') {
      const res = await fetch(`/api/complaints?store_id=${storeId}`);
      const data = await res.json();
      const complaints = data.complaints || [];

      panel.innerHTML = `
        <div class="section-title">⚠️ Penanganan Komplain & Refund Konsumen</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:16px;">
          Tinjau pengajuan komplain pelanggan dan berikan keputusan refund ke saldo dompet pelanggan.
        </p>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>No. Pesanan</th>
                <th>Konsumen</th>
                <th>Alasan Komplain</th>
                <th>Detail</th>
                <th>Status</th>
                <th>Aksi Toko</th>
              </tr>
            </thead>
            <tbody>
              ${complaints.length === 0 ? `
                <tr><td colspan="6" style="text-align:center; padding:30px;">Tidak ada komplain aktif saat ini.</td></tr>
              ` : complaints.map(c => `
                <tr>
                  <td><strong>${c.order_id}</strong></td>
                  <td>${c.user_name}</td>
                  <td><strong style="color:var(--accent-red);">${c.reason}</strong></td>
                  <td>${c.details || '-'}</td>
                  <td><span class="role-tag">${c.status}</span></td>
                  <td>
                    ${c.status === 'pending' ? `
                      <button class="btn-topup-cash" onclick="app.resolveComplaintModal('${c.id}', ${c.total_amount})">
                        Proses Refund
                      </button>
                    ` : `<span>${c.resolution_notes || 'Selesai'}</span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (tab === 'reports') {
      const res = await fetch(`/api/reports?store_id=${storeId}`);
      const data = await res.json();
      const audits = data.audit_logs || [];

      panel.innerHTML = `
        <div class="section-title">📜 Laporan Keuangan & Jejak Audit Transaksi</div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom:16px;">
          Log audit append-only yang tidak dapat diubah untuk melacak semua transaksi keuangan dan operasional.
        </p>

        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Aksi</th>
                <th>Tipe Entitas</th>
                <th>Aktor</th>
                <th>Rincian Audit</th>
              </tr>
            </thead>
            <tbody>
              ${audits.map(a => `
                <tr>
                  <td>${new Date(a.created_at).toLocaleString('id-ID')}</td>
                  <td><strong>${a.action}</strong></td>
                  <td>${a.entity_type}</td>
                  <td>${a.actor_name}</td>
                  <td>${a.details}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  },

  async updateOrderStatus(orderId, status, courierId = null) {
    try {
      const res = await fetch('/api/orders/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          status: status,
          actor_id: appState.currentUser.id,
          actor_role: appState.currentRole,
          courier_id: courierId
        })
      });
      if (res.ok) {
        this.renderAdminTabContent(appState.currentUser.store_id || 'store-kemang');
      }
    } catch (err) {
      alert('Gagal update status: ' + err.message);
    }
  },

  async confirmCashierTopup(code) {
    if (!code) {
      alert('Mohon masukkan kode top up.');
      return;
    }
    try {
      const res = await fetch('/api/wallet/topup/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          cashier_id: appState.currentUser.id
        })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Konfirmasi top up gagal.');
        return;
      }
      alert(`Sukses! Pembayaran tunai sebesar ${formatRupiah(data.amount)} terkonfirmasi. Saldo CS Pay konsumen telah bertambah.`);
      this.renderAdminTabContent(appState.currentUser.store_id || 'store-kemang');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  },

  /* =========================================================================
     UPDATE 1: PHOTO UPLOAD TO SYSTEM FOLDER (/public/uploads)
     ========================================================================= */
  openAdminProductModal(prodId = null) {
    const prod = prodId ? appState.products.find(p => p.id === prodId) : null;
    const container = document.getElementById('modal-container');
    const images = prod ? (Array.isArray(prod.images) ? prod.images : JSON.parse(prod.images_json || '[]')) : [];

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:560px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">${prod ? 'Edit Produk' : 'Tambah Produk Baru'}</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>

          <div style="padding:20px; max-height:75vh; overflow-y:auto;">
            <div class="form-group">
              <label class="form-label">Nama Produk</label>
              <input type="text" id="adm-p-name" class="form-input" value="${prod ? prod.name : ''}">
            </div>
            <div class="form-group">
              <label class="form-label">SKU</label>
              <input type="text" id="adm-p-sku" class="form-input" value="${prod ? prod.sku : 'SKU-' + Date.now().toString().slice(-4)}">
            </div>
            <div class="form-group">
              <label class="form-label">Kategori</label>
              <select id="adm-p-cat" class="form-select">
                <option value="Makanan & Camilan" ${prod && prod.category === 'Makanan & Camilan' ? 'selected' : ''}>Makanan & Camilan</option>
                <option value="Minuman Segar" ${prod && prod.category === 'Minuman Segar' ? 'selected' : ''}>Minuman Segar</option>
                <option value="Kebutuhan Dapur" ${prod && prod.category === 'Kebutuhan Dapur' ? 'selected' : ''}>Kebutuhan Dapur</option>
                <option value="Roti & Sarapan" ${prod && prod.category === 'Roti & Sarapan' ? 'selected' : ''}>Roti & Sarapan</option>
                <option value="Buah & Sayur" ${prod && prod.category === 'Buah & Sayur' ? 'selected' : ''}>Buah & Sayur</option>
                <option value="Perawatan Rumah" ${prod && prod.category === 'Perawatan Rumah' ? 'selected' : ''}>Perawatan Rumah</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group">
                <label class="form-label">Harga Aktif (Rp)</label>
                <input type="number" id="adm-p-price" class="form-input" value="${prod ? prod.price : 10000}">
              </div>
              <div class="form-group">
                <label class="form-label">Harga Coret Lama (Opsional)</label>
                <input type="number" id="adm-p-oldprice" class="form-input" value="${prod && prod.old_price ? prod.old_price : ''}">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group">
                <label class="form-label">Stok</label>
                <input type="number" id="adm-p-stock" class="form-input" value="${prod ? prod.stock : 50}">
              </div>
              <div class="form-group">
                <label class="form-label">Satuan</label>
                <input type="text" id="adm-p-unit" class="form-input" value="${prod ? prod.unit : 'Pcs'}">
              </div>
            </div>

            <!-- Upload Foto ke Folder Sistem (Update 1) -->
            <div class="form-group">
              <label class="form-label">📁 Upload Foto Produk ke Folder Sistem (Bisa > 1 Foto)</label>
              <div class="upload-dropzone" onclick="document.getElementById('adm-p-file').click()">
                <input type="file" id="adm-p-file" multiple accept="image/*" style="display:none;" onchange="app.handleAdminFileUpload(event)">
                <div style="font-size:1.6rem; margin-bottom:4px;">📸📁</div>
                <div style="font-weight:700; color:var(--primary); font-size:0.85rem;">Klik untuk Memilih Foto dari Perangkat</div>
                <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">
                  Foto otomatis disimpan ke folder <code>public/uploads/</code> di server dan dibuatkan urutan bernomor 1, 2, 3...
                </div>
              </div>

              <!-- Thumbnail Previews -->
              <div id="adm-upload-previews" class="upload-previews-grid">
                ${images.map((url, idx) => `
                  <div class="upload-preview-item" id="prev-item-${idx}">
                    <img src="${url}">
                    <button type="button" class="upload-preview-remove" onclick="app.removeAdminUploadPhoto(${idx})">✕</button>
                    <div style="position:absolute; bottom:2px; left:2px; background:#090765; color:#dbc911; font-size:0.6rem; font-weight:800; padding:1px 4px; border-radius:4px;">${idx + 1}</div>
                  </div>
                `).join('')}
              </div>

              <textarea id="adm-p-images" class="form-input" rows="2" style="margin-top:8px; font-size:0.75rem;" placeholder="Daftar URL Foto">${images.join(', ')}</textarea>
            </div>

            <div class="form-group">
              <label class="form-label">Deskripsi Produk</label>
              <textarea id="adm-p-desc" class="form-input" rows="2">${prod ? prod.description : ''}</textarea>
            </div>

            <div style="display:flex; gap:16px; margin-top:10px;">
              <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; font-weight:700;">
                <input type="checkbox" id="adm-p-featured" ${prod && prod.is_featured ? 'checked' : ''}> Produk Unggulan
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; font-weight:700;">
                <input type="checkbox" id="adm-p-freeship" ${prod && prod.is_free_shipping ? 'checked' : ''}> Gratis Ongkir
              </label>
            </div>

            <div style="margin-top:20px; display:flex; gap:10px;">
              <button class="btn-checkout-submit" style="background:var(--primary); flex:1;" onclick="app.saveAdminProduct('${prod ? prod.id : ''}')">
                Simpan Produk
              </button>
              ${prod ? `
                <button class="filter-pill" style="color:var(--accent-red); border-color:var(--accent-red);" onclick="app.deleteAdminProduct('${prod.id}')">
                  Hapus
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  async handleAdminFileUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const filesPayload = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const base64Data = await this.readFileAsDataURL(file);
      filesPayload.push({
        filename: file.name,
        data: base64Data
      });
    }

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesPayload })
      });
      const data = await res.json();
      if (data.success && data.urls) {
        const textarea = document.getElementById('adm-p-images');
        let currentUrls = textarea.value.split(',').map(s => s.trim()).filter(Boolean);
        currentUrls = currentUrls.concat(data.urls);
        textarea.value = currentUrls.join(', ');

        // Update previews
        const previewContainer = document.getElementById('adm-upload-previews');
        if (previewContainer) {
          previewContainer.innerHTML = currentUrls.map((url, idx) => `
            <div class="upload-preview-item" id="prev-item-${idx}">
              <img src="${url}">
              <button type="button" class="upload-preview-remove" onclick="app.removeAdminUploadPhoto(${idx})">✕</button>
              <div style="position:absolute; bottom:2px; left:2px; background:#090765; color:#dbc911; font-size:0.6rem; font-weight:800; padding:1px 4px; border-radius:4px;">${idx + 1}</div>
            </div>
          `).join('');
        }
        alert(`Berhasil mengunggah ${data.urls.length} foto ke folder sistem public/uploads/!`);
      }
    } catch (err) {
      alert('Gagal upload foto: ' + err.message);
    }
  },

  removeAdminUploadPhoto(index) {
    const textarea = document.getElementById('adm-p-images');
    if (!textarea) return;
    let currentUrls = textarea.value.split(',').map(s => s.trim()).filter(Boolean);
    currentUrls.splice(index, 1);
    textarea.value = currentUrls.join(', ');

    const previewContainer = document.getElementById('adm-upload-previews');
    if (previewContainer) {
      previewContainer.innerHTML = currentUrls.map((url, idx) => `
        <div class="upload-preview-item" id="prev-item-${idx}">
          <img src="${url}">
          <button type="button" class="upload-preview-remove" onclick="app.removeAdminUploadPhoto(${idx})">✕</button>
          <div style="position:absolute; bottom:2px; left:2px; background:#090765; color:#dbc911; font-size:0.6rem; font-weight:800; padding:1px 4px; border-radius:4px;">${idx + 1}</div>
        </div>
      `).join('');
    }
  },

  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  async saveAdminProduct(id = '') {
    const name = document.getElementById('adm-p-name').value;
    const sku = document.getElementById('adm-p-sku').value;
    const category = document.getElementById('adm-p-cat').value;
    const price = document.getElementById('adm-p-price').value;
    const oldPrice = document.getElementById('adm-p-oldprice').value;
    const stock = document.getElementById('adm-p-stock').value;
    const unit = document.getElementById('adm-p-unit').value;
    const desc = document.getElementById('adm-p-desc').value;
    const imagesRaw = document.getElementById('adm-p-images').value;
    const isFeatured = document.getElementById('adm-p-featured').checked;
    const isFreeShipping = document.getElementById('adm-p-freeship').checked;

    const images = imagesRaw.split(',').map(s => s.trim()).filter(Boolean);

    try {
      const res = await fetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id || undefined,
          store_id: appState.currentUser.store_id || 'store-kemang',
          admin_id: appState.currentUser.id,
          name, sku, category, price, old_price: oldPrice, stock, unit, description: desc,
          images, is_featured: isFeatured, is_free_shipping: isFreeShipping
        })
      });
      if (res.ok) {
        this.closeModal();
        await this.loadCatalog();
        this.renderAdminTabContent(appState.currentUser.store_id || 'store-kemang');
      }
    } catch (err) {
      alert('Gagal menyimpan produk: ' + err.message);
    }
  },

  async deleteAdminProduct(prodId) {
    if (!confirm('Yakin ingin menonaktifkan produk ini dari katalog?')) return;
    try {
      const res = await fetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          id: prodId,
          admin_id: appState.currentUser.id
        })
      });
      if (res.ok) {
        this.closeModal();
        await this.loadCatalog();
        this.renderAdminTabContent(appState.currentUser.store_id || 'store-kemang');
      }
    } catch (err) {
      alert('Gagal menghapus produk: ' + err.message);
    }
  },

  async saveTierSettings() {
    const gold = document.getElementById('tier-gold-input').value;
    const plat = document.getElementById('tier-plat-input').value;
    const evalM = document.getElementById('tier-eval-input').value;

    try {
      const res = await fetch('/api/tier-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_id: appState.currentUser.id,
          gold_min: gold,
          platinum_min: plat,
          evaluation_months: evalM
        })
      });
      if (res.ok) {
        alert('Pengaturan batas belanja tier member berhasil diperbarui!');
      }
    } catch (err) {
      alert('Gagal menyimpan: ' + err.message);
    }
  },

  resolveComplaintModal(complaintId, totalAmount) {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">Keputusan Refund Komplain</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>
          <div style="padding:20px;">
            <div class="form-group">
              <label class="form-label">Nominal Refund ke Saldo CS Pay Konsumen</label>
              <input type="number" id="cmp-refund-amount" class="form-input" value="${totalAmount}">
            </div>
            <div class="form-group">
              <label class="form-label">Catatan Keputusan / Alasan Refund</label>
              <input type="text" id="cmp-refund-notes" class="form-input" placeholder="Contoh: Barang bocor, disetujui refund penuh">
            </div>
            <button class="btn-checkout-submit" style="background:var(--success);" onclick="app.submitComplaintDecision('${complaintId}', 'refund_wallet')">
              Setujui & Refund ke Saldo CS Pay
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async submitComplaintDecision(complaintId, decision) {
    const refundAmount = document.getElementById('cmp-refund-amount').value;
    const notes = document.getElementById('cmp-refund-notes').value;

    try {
      const res = await fetch('/api/complaints/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaint_id: complaintId,
          admin_id: appState.currentUser.id,
          decision: decision,
          refund_amount: refundAmount,
          notes: notes
        })
      });
      if (res.ok) {
        alert('Keputusan refund berhasil diproses dan saldo dikreditkan ke konsumen.');
        this.closeModal();
        this.renderAdminTabContent(appState.currentUser.store_id || 'store-kemang');
      }
    } catch (err) {
      alert('Gagal: ' + err.message);
    }
  },

  /* =========================================================================
     8. COURIER PORTAL (PRD 3.3)
     ========================================================================= */
  renderCourierView(container) {
    const u = appState.currentUser || {};
    container.innerHTML = `
      <section style="max-width:800px; margin:0 auto;">
        <!-- Courier Header -->
        <div style="background:linear-gradient(90deg, #090765, #1e1b4b); color:white; padding:20px; border-radius:var(--radius-lg); margin-bottom:20px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-size:0.75rem; color:#fde047; font-weight:700;">PORTAL PENGANTARAN KURIR</div>
            <h2 style="font-size:1.3rem; font-weight:800;">${u.name}</h2>
            <div style="font-size:0.8rem; color:#cbd5e1;">Motor Honda Beat • CS Mart Kemang</div>
          </div>
          <div style="text-align:right;">
            <div style="background:rgba(22, 163, 74, 0.2); color:#4ade80; border:1px solid #4ade80; padding:4px 10px; border-radius:var(--radius-full); font-size:0.75rem; font-weight:700;">
              🟢 Status: Siap Mengantar
            </div>
          </div>
        </div>

        <div class="section-title">📦 Tugas Pengantaran Aktif</div>
        <div id="courier-tasks-container">
          <!-- Loaded dynamically -->
        </div>
      </section>
    `;

    this.loadCourierTasks();
  },

  async loadCourierTasks() {
    const container = document.getElementById('courier-tasks-container');
    if (!container) return;

    try {
      const res = await fetch(`/api/courier/tasks?courier_id=${appState.currentUser.id}`);
      const data = await res.json();
      const tasks = data.tasks || [];

      if (tasks.length === 0) {
        container.innerHTML = `
          <div style="background:white; border-radius:var(--radius-md); padding:40px; text-align:center; color:var(--text-muted); border:1px dashed var(--border-color);">
            <div style="font-size:2.5rem; margin-bottom:10px;">🛵</div>
            <div style="font-weight:700; color:var(--text-main);">Belum ada tugas pengantaran baru</div>
            <div style="font-size:0.82rem; margin-top:4px;">Tugas baru dari toko CS Mart akan muncul di sini.</div>
          </div>
        `;
        return;
      }

      container.innerHTML = tasks.map(t => `
        <div style="background:white; border-radius:var(--radius-lg); border:1px solid var(--border-color); padding:18px; margin-bottom:14px; box-shadow:var(--shadow-sm);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
            <div>
              <div style="font-weight:800; font-size:1.05rem; color:var(--primary);">Pesanan ${t.id}</div>
              <div style="font-size:0.78rem; color:var(--text-muted);">Toko: ${t.store_name} • Konsumen: ${t.customer_name} (${t.customer_phone})</div>
            </div>
            <span class="role-tag" style="background:#090765; color:white;">${t.status}</span>
          </div>

          <div style="background:#f8fafc; padding:10px 14px; border-radius:var(--radius-md); font-size:0.82rem; margin-bottom:14px;">
            📍 <strong>Alamat Tujuan:</strong> ${t.address_snapshot}
            ${t.order_notes ? `<div style="margin-top:4px; color:#d97706;">📝 Catatan: ${t.order_notes}</div>` : ''}
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            ${t.status === 'awaiting_courier' || !t.courier_id ? `
              <button class="btn-checkout-submit" style="background:var(--success); flex:1;" onclick="app.updateOrderStatus('${t.id}', 'assigned', '${appState.currentUser.id}')">
                ✓ Terima Tugas Pengantaran
              </button>
            ` : t.status === 'assigned' ? `
              <button class="btn-checkout-submit" style="background:var(--primary); flex:1;" onclick="app.updateOrderStatus('${t.id}', 'picked_up')">
                Ambil Pesanan di Toko
              </button>
            ` : t.status === 'picked_up' ? `
              <button class="btn-checkout-submit" style="background:#0284c7; flex:1;" onclick="app.updateOrderStatus('${t.id}', 'in_transit')">
                Mulai Jalan (Dalam Perjalanan)
              </button>
            ` : t.status === 'in_transit' ? `
              <button class="btn-checkout-submit" style="background:var(--success); flex:1;" onclick="app.updateOrderStatus('${t.id}', 'delivered')">
                ✓ Konfirmasi Serah Terima (Sampai)
              </button>
            ` : ''}

            <button class="filter-pill" onclick="app.openOrderTracker('${t.id}')">
              💬 Buka Chat & Peta
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error(err);
    }
  },

  /* =========================================================================
     UPDATE 6: CENTRAL ADMIN PORTAL & STORE CRUD (Create, Update, Delete, Toggle)
     ========================================================================= */
  async renderCentralAdminView(container) {
    const res = await fetch('/api/reports');
    const data = await res.json();
    const audits = data.audit_logs || [];

    // Re-fetch stores to get newest state
    await this.fetchStores();

    container.innerHTML = `
      <section style="max-width:1100px; margin:0 auto;">
        <div style="background:linear-gradient(90deg, #090765, #05043d); color:white; padding:24px; border-radius:var(--radius-lg); margin-bottom:24px;">
          <div style="font-size:0.75rem; color:#dbc911; font-weight:800; letter-spacing:0.5px;">ADMINISTRATOR PUSAT JARINGAN</div>
          <h1 style="font-size:1.5rem; font-weight:800;">Dashboard Pusat CS Mart Delivery</h1>
          <div style="font-size:0.85rem; color:#cbd5e1;">Pengawasan jaringan toko minimarket, omzet lintas cabang, dan kelola cabang aktif/nonaktif.</div>
        </div>

        <div class="stats-cards-grid">
          <div class="stat-card-admin">
            <div class="stat-card-title">Total GMV Seluruh Toko</div>
            <div class="stat-card-number">${formatRupiah(data.total_gmv || 0)}</div>
          </div>
          <div class="stat-card-admin">
            <div class="stat-card-title">Total Toko Jaringan</div>
            <div class="stat-card-number">${appState.stores.length} Cabang</div>
          </div>
          <div class="stat-card-admin">
            <div class="stat-card-title">Total Transaksi Selesai</div>
            <div class="stat-card-number">${data.completed_orders || 0}</div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:24px; margin-bottom:12px;">
          <div class="section-title">🏪 Kelola Toko Jaringan CS Mart (CRUD)</div>
          <button class="btn-checkout-submit" style="width:auto; padding:8px 16px; background:var(--primary);" onclick="app.openStoreFormModal()">
            + Tambah Toko Cabang Baru
          </button>
        </div>

        <!-- Stores Table with Active/Inactive Toggle -->
        <div class="data-table-container" style="margin-bottom:30px;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nama Toko</th>
                <th>Alamat & Telepon</th>
                <th>Jam Buka</th>
                <th>Radius Antar</th>
                <th>Tarif Dasar</th>
                <th>Status Toko</th>
                <th>Aksi Central</th>
              </tr>
            </thead>
            <tbody>
              ${appState.stores.map(st => `
                <tr>
                  <td><strong>${st.name}</strong></td>
                  <td>${st.address} <br><span style="font-size:0.7rem; color:var(--text-muted);">${st.phone || '-'}</span></td>
                  <td>${st.operating_hours}</td>
                  <td>${st.delivery_radius_km} km</td>
                  <td>${formatRupiah(st.base_fare)}</td>
                  <td>
                    <!-- Toggle Active/Inactive (Update 6) -->
                    <button class="switch-status-btn ${st.is_active ? 'active' : 'inactive'}" 
                      onclick="app.toggleStoreActive('${st.id}')" 
                      title="Klik untuk ubah status aktif/nonaktif">
                      ${st.is_active ? '🟢 Aktif' : '🔴 Nonaktif'}
                    </button>
                  </td>
                  <td>
                    <button class="filter-pill" style="font-size:0.75rem; padding:4px 8px; margin-right:4px;" onclick="app.openStoreFormModal('${st.id}')">
                      ✏️ Edit
                    </button>
                    <button class="filter-pill" style="font-size:0.75rem; padding:4px 8px; color:var(--accent-red); border-color:var(--accent-red);" onclick="app.deleteStore('${st.id}')">
                      🗑️
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="section-title">📜 Jejak Audit Global Append-Only</div>
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Waktu (UTC/WIB)</th>
                <th>Aksi</th>
                <th>Tipe</th>
                <th>Aktor</th>
                <th>Keterangan Transaksi</th>
              </tr>
            </thead>
            <tbody>
              ${audits.map(a => `
                <tr>
                  <td>${new Date(a.created_at).toLocaleString('id-ID')}</td>
                  <td><strong>${a.action}</strong></td>
                  <td>${a.entity_type}</td>
                  <td>${a.actor_name}</td>
                  <td>${a.details}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    `;
  },

  async toggleStoreActive(storeId) {
    try {
      const res = await fetch('/api/central/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle_active',
          id: storeId,
          admin_id: appState.currentUser.id
        })
      });
      const data = await res.json();
      if (data.success) {
        await this.fetchStores();
        const container = document.getElementById('main-content');
        this.renderCentralAdminView(container);
      }
    } catch (err) {
      alert('Gagal mengubah status toko: ' + err.message);
    }
  },

  openStoreFormModal(storeId = null) {
    const st = storeId ? appState.stores.find(s => s.id === storeId) : null;
    const container = document.getElementById('modal-container');

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:500px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">${st ? 'Edit Toko Cabang' : 'Tambah Toko Cabang Baru'}</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>

          <div style="padding:20px; max-height:75vh; overflow-y:auto;">
            <div class="form-group">
              <label class="form-label">Nama Toko CS Mart</label>
              <input type="text" id="adm-st-name" class="form-input" placeholder="Misal: CS Mart Tebet" value="${st ? st.name : ''}">
            </div>
            <div class="form-group">
              <label class="form-label">Alamat Lengkap</label>
              <input type="text" id="adm-st-address" class="form-input" placeholder="Jl. Raya..." value="${st ? st.address : ''}">
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group">
                <label class="form-label">Nomor Telepon Toko</label>
                <input type="text" id="adm-st-phone" class="form-input" placeholder="021-..." value="${st ? st.phone : '021-7890011'}">
              </div>
              <div class="form-group">
                <label class="form-label">Jam Operasional</label>
                <input type="text" id="adm-st-hours" class="form-input" placeholder="07:00 - 22:00" value="${st ? st.operating_hours : '07:00 - 22:00'}">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group">
                <label class="form-label">Radius Antar (Km)</label>
                <input type="number" id="adm-st-radius" class="form-input" value="${st ? st.delivery_radius_km : 15}">
              </div>
              <div class="form-group">
                <label class="form-label">Tarif Dasar Ongkir (Rp)</label>
                <input type="number" id="adm-st-basefare" class="form-input" value="${st ? st.base_fare : 8000}">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <div class="form-group">
                <label class="form-label">Tarif per Km (Rp)</label>
                <input type="number" id="adm-st-perkm" class="form-input" value="${st ? st.per_km_fare : 2500}">
              </div>
              <div class="form-group">
                <label class="form-label">Status Toko</label>
                <select id="adm-st-active" class="form-select">
                  <option value="1" ${st && st.is_active ? 'selected' : ''}>Aktif</option>
                  <option value="0" ${st && !st.is_active ? 'selected' : ''}>Nonaktif</option>
                </select>
              </div>
            </div>

            <button class="btn-checkout-submit" style="background:var(--primary); margin-top:14px;" onclick="app.saveStoreCentral('${st ? st.id : ''}')">
              ${st ? 'Simpan Perubahan Toko' : 'Tambah Toko Baru'}
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async saveStoreCentral(storeId = '') {
    const name = document.getElementById('adm-st-name').value.trim();
    const address = document.getElementById('adm-st-address').value.trim();
    const phone = document.getElementById('adm-st-phone').value.trim();
    const hours = document.getElementById('adm-st-hours').value.trim();
    const radius = document.getElementById('adm-st-radius').value;
    const baseFare = document.getElementById('adm-st-basefare').value;
    const perKm = document.getElementById('adm-st-perkm').value;
    const isActive = document.getElementById('adm-st-active').value;

    if (!name || !address) {
      alert('Nama dan alamat toko wajib diisi.');
      return;
    }

    try {
      const res = await fetch('/api/central/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: storeId ? 'update' : 'create',
          id: storeId || undefined,
          admin_id: appState.currentUser.id,
          name, address, phone,
          operating_hours: hours,
          delivery_radius_km: parseFloat(radius),
          base_fare: parseInt(baseFare),
          per_km_fare: parseInt(perKm),
          is_active: parseInt(isActive)
        })
      });
      const data = await res.json();
      if (data.success) {
        this.closeModal();
        await this.fetchStores();
        const container = document.getElementById('main-content');
        this.renderCentralAdminView(container);
        alert('Toko cabang berhasil disimpan!');
      }
    } catch (err) {
      alert('Gagal: ' + err.message);
    }
  },

  async deleteStore(storeId) {
    if (!confirm('Apakah Anda yakin ingin menghapus toko cabang ini dari jaringan CS Mart?')) return;
    try {
      const res = await fetch('/api/central/stores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          id: storeId,
          admin_id: appState.currentUser.id
        })
      });
      if (res.ok) {
        await this.fetchStores();
        const container = document.getElementById('main-content');
        this.renderCentralAdminView(container);
      }
    } catch (err) {
      alert('Gagal menghapus toko: ' + err.message);
    }
  },

  /* =========================================================================
     10. STORE PICKER & CONFIRMATION (PRD 25.1)
     ========================================================================= */
  openStoreModal() {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">📍 Pilih Toko Minimarket</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>
          <div style="padding:20px;">
            <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:14px;">
              Pilih toko cabang CS Mart terdekat untuk melihat stok dan penawaran promosi lokal:
            </div>

            ${appState.stores.map(st => `
              <div style="background:${st.id === appState.currentStoreId ? '#eff6ff' : '#f8fafc'}; border:1px solid ${st.id === appState.currentStoreId ? 'var(--primary)' : 'var(--border-color)'}; border-radius:var(--radius-md); padding:14px; margin-bottom:10px; cursor:pointer;" onclick="app.selectStore('${st.id}')">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <strong style="color:var(--primary); font-size:0.95rem;">${st.name}</strong>
                  ${st.id === appState.currentStoreId ? '<span class="role-tag">Toko Aktif</span>' : (st.is_active ? '<span class="role-tag" style="background:#dcfce7; color:#15803d;">Buka</span>' : '<span class="role-tag" style="background:#fee2e2; color:#b91c1c;">Tutup</span>')}
                </div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">${st.address}</div>
                <div style="font-size:0.75rem; color:var(--success); font-weight:700; margin-top:4px;">
                  Jam Buka: ${st.operating_hours || '07:00 - 22:00'}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  },

  selectStore(storeId) {
    if (storeId === appState.currentStoreId) {
      this.closeModal();
      return;
    }

    if (appState.cart.length > 0) {
      const confirmChange = confirm('Perhatian: Mengganti toko akan mengosongkan keranjang belanja karena stok, harga, dan tarif ongkir tiap toko berbeda. Lanjutkan ganti toko?');
      if (!confirmChange) return;
      appState.cart = [];
      this.updateFloatingCartBar();
    }

    appState.currentStoreId = storeId;
    this.closeModal();
    this.refreshCatalog();
  },

  /* =========================================================================
     11. NOTIFICATIONS & BADGING API (PRD 10)
     ========================================================================= */
  addNotification(title, body) {
    const notif = {
      id: 'notif-' + Date.now(),
      title,
      body,
      time: new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' }),
      read: false
    };
    appState.notifications.unshift(notif);
    this.updateNotificationBadge();

    if ('setAppBadge' in navigator) {
      const unreadCount = appState.notifications.filter(n => !n.read).length;
      navigator.setAppBadge(unreadCount).catch(() => {});
    }
  },

  updateNotificationBadge() {
    const unread = appState.notifications.filter(n => !n.read).length;

    // 1. Red Badge on Main App Icon (Header Brand Logo)
    const appBadge = document.getElementById('app-icon-badge');
    if (appBadge) {
      if (unread > 0) {
        appBadge.style.display = 'flex';
        appBadge.textContent = unread > 9 ? '9+' : unread;
      } else {
        appBadge.style.display = 'none';
      }
    }

    // 2. Red Badge on Header Notification Bell
    const bellBadge = document.getElementById('notif-badge');
    if (bellBadge) {
      if (unread > 0) {
        bellBadge.style.display = 'flex';
        bellBadge.textContent = unread > 9 ? '9+' : unread;
      } else {
        bellBadge.style.display = 'none';
      }
    }

    // 3. Red Badge on Bottom Mobile Navigation Bar
    const bottomBadge = document.getElementById('bottom-notif-badge');
    if (bottomBadge) {
      if (unread > 0) {
        bottomBadge.style.display = 'flex';
        bottomBadge.textContent = unread > 9 ? '9+' : unread;
      } else {
        bottomBadge.style.display = 'none';
      }
    }

    // 4. Native OS-Level App Badging API (Installed PWA on Android / Desktop / iOS)
    if ('setAppBadge' in navigator) {
      if (unread > 0) {
        navigator.setAppBadge(unread).catch(() => {});
      } else {
        navigator.clearAppBadge().catch(() => {});
      }
    }

    // 5. Dynamic HTML5 Canvas Favicon & Touch Icon with Red Badge
    this.drawFaviconWithBadge(unread);

    // 6. Sync with Service Worker for Android Launcher Home Screen Notification Dot
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        const payload = {
          type: 'SET_BADGE',
          count: unread,
          title: 'CS Mart Delivery',
          body: unread > 0 ? `Ada ${unread} promo & notifikasi baru di akun Anda!` : ''
        };
        if (reg.active) {
          reg.active.postMessage(payload);
        } else if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage(payload);
        }

        // Also trigger showNotification directly if permission granted to force launcher dot
        if (unread > 0 && 'Notification' in window && Notification.permission === 'granted') {
          reg.showNotification('CS Mart Delivery 🛒', {
            body: `Ada ${unread} promo & notifikasi baru di akun Anda!`,
            icon: '/assets/icon-192.png?v=badge',
            badge: '/assets/badge-96.png?v=badge',
            tag: 'csmart-badge-notification',
            renotify: false,
            silent: true
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  },

  drawFaviconWithBadge(count) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.src = '/assets/icon-192.png';
      img.onload = () => {
        ctx.clearRect(0, 0, 64, 64);
        ctx.drawImage(img, 0, 0, 64, 64);

        if (count > 0) {
          // White border ring
          ctx.beginPath();
          ctx.arc(48, 16, 14, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          // Red badge circle
          ctx.beginPath();
          ctx.arc(48, 16, 12, 0, 2 * Math.PI);
          ctx.fillStyle = '#dc2626';
          ctx.fill();

          // White text
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 15px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(count > 9 ? '9+' : String(count), 48, 16);
        }

        const dataUrl = canvas.toDataURL('image/png');
        const icons = document.querySelectorAll("link[rel*='icon'], link[rel='apple-touch-icon']");
        icons.forEach(el => el.href = dataUrl);
      };
    } catch (e) {
      console.warn('Favicon badge error:', e);
    }
  },

  async sendTestBadgeNotification() {
    if ('Notification' in window) {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          alert('Mohon pilih "Izinkan" (Allow) pada notifikasi browser agar titik merah dapat muncul di ikon layar utama HP Anda.');
          return;
        }
      }

      this.addNotification('CS Mart Delivery 🛒', 'Ada 3 promo hemat minimarket belum Anda gunakan!');

      // Native App Badging API directly on window
      if ('setAppBadge' in navigator) {
        navigator.setAppBadge(3).catch(e => console.warn('setAppBadge window:', e));
      }

      // Notify Service Worker
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SET_BADGE',
            count: 3
          });
        }
        reg.showNotification('CS Mart Delivery 🛒', {
          body: 'Ada 3 promo baru & diskon belum dibaca di akun Anda!',
          icon: '/assets/icon-192.png',
          badge: '/assets/badge-96.png',
          tag: 'csmart-badge-notification',
          renotify: true,
          vibrate: [200, 100, 200]
        });
      }

      this.drawFaviconWithBadge(3);

      alert('✅ Notifikasi aktif berhasil dikirim ke HP Anda!\n\n1. Lihat ke bilah atas HP (Status Bar) — ada notifikasi dari CS Mart.\n2. Tekan tombol Home untuk kembali ke Layar Utama HP: titik/lencana merah sekarang sudah muncul di atas ikon CS Mart!');
    } else {
      alert('Perangkat ini tidak mendukung Web Notifications.');
    }
  },

  toggleNotifications() {
    const container = document.getElementById('modal-container');
    const unreadCount = appState.notifications.filter(n => !n.read).length;

    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">🔔 Notifikasi & Pesan Masuk (${unreadCount})</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>
          <div style="padding:16px; max-height:70vh; overflow-y:auto;">
            ${appState.notifications.map(n => `
              <div style="border-bottom:1px solid var(--border-color); padding:10px 0; opacity:${n.read ? '0.65' : '1'};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <strong style="font-size:0.85rem; color:var(--primary);">${n.read ? '' : '<span style="color:#ef4444; margin-right:4px;">●</span>'}${n.title}</strong>
                  <span style="font-size:0.7rem; color:var(--text-light);">${n.time}</span>
                </div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">${n.body}</div>
              </div>
            `).join('')}

            <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
              <button class="filter-pill" style="width:100%; text-align:center; padding:10px; background:#fef2f2; color:#b91c1c; border-color:#fca5a5; font-weight:700;" onclick="app.sendTestBadgeNotification()">
                🔴 Uji Munculkan Titik Merah di Ikon Layar HP
              </button>
              <button class="filter-pill" style="width:100%; text-align:center; padding:8px; background:#f1f5f9; color:#475569; border:none; font-size:0.75rem;" onclick="app.markAllNotificationsRead()">
                Tandai Semua Sudah Dibaca
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  markAllNotificationsRead() {
    appState.notifications.forEach(n => n.read = true);
    this.updateNotificationBadge();
    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
    this.drawFaviconWithBadge(0);
    this.toggleNotifications();
  },

  /* =========================================================================
     12. TAB NAVIGATION (Orders history, Wallet ledger, Wishlist)
     ========================================================================= */
  async navigateTab(tabName) {
    document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`tab-${tabName}`);
    if (activeBtn) activeBtn.classList.add('active');

    if (tabName === 'home') {
      this.render();
      return;
    }

    if (tabName === 'account') {
      this.openLoginModal();
      return;
    }

    if (!appState.currentUser) {
      this.openLoginModal();
      return;
    }

    const container = document.getElementById('main-content');
    if (tabName === 'orders') {
      const res = await fetch(`/api/orders?user_id=${appState.currentUser.id}`);
      const data = await res.json();
      const orders = data.orders || [];

      container.innerHTML = `
        <div style="max-width:700px; margin:0 auto;">
          <div class="section-title" style="margin-bottom:16px;">📦 Riwayat Pesanan Saya</div>
          ${orders.length === 0 ? `
            <div style="background:white; border-radius:var(--radius-md); padding:40px; text-align:center; color:var(--text-muted); border:1px dashed var(--border-color);">
              <div style="font-size:2.5rem; margin-bottom:8px;">🛍️</div>
              <div style="font-weight:700;">Belum ada pesanan</div>
              <div style="font-size:0.82rem;">Ayo mulai pesan produk minimarket sekarang!</div>
            </div>
          ` : orders.map(o => `
            <div style="background:white; border-radius:var(--radius-md); border:1px solid var(--border-color); padding:16px; margin-bottom:12px; box-shadow:var(--shadow-sm);">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <div>
                  <strong style="color:var(--primary); font-size:0.95rem;">${o.id}</strong>
                  <div style="font-size:0.75rem; color:var(--text-muted);">${o.store_name} • ${new Date(o.created_at).toLocaleString('id-ID')}</div>
                </div>
                <span class="role-tag" style="background:#090765; color:white;">${o.status}</span>
              </div>
              <div style="font-size:0.82rem; margin:8px 0; color:var(--text-main);">
                ${o.items ? o.items.map(it => `${it.product_name} (${it.quantity}x)`).join(', ') : ''}
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #f1f5f9; padding-top:8px;">
                <span style="font-weight:800; color:var(--primary);">${formatRupiah(o.total_amount)}</span>
                <button class="filter-pill" style="font-size:0.75rem; padding:4px 10px;" onclick="app.openOrderTracker('${o.id}')">
                  Lacak Pesanan / Chat
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else if (tabName === 'wallet') {
      const res = await fetch(`/api/wallet/ledger?user_id=${appState.currentUser.id}`);
      const data = await res.json();
      const wled = data.wallet_ledger || [];

      container.innerHTML = `
        <div style="max-width:700px; margin:0 auto;">
          <div class="member-summary-card">
            <div style="font-size:0.8rem; color:#cbd5e1;">Saldo CS Pay Aktif</div>
            <div style="font-size:1.8rem; font-weight:800; color:white;">${formatRupiah(appState.currentUser.wallet_balance || 0)}</div>
            <div style="margin-top:10px;">
              <button class="btn-topup-cash" onclick="app.openCashTopupModal()">+ Top Up Tunai di Kasir</button>
            </div>
          </div>

          <div class="section-title" style="margin-bottom:12px;">📒 Buku Catatan Saldo (Ledger Append-Only)</div>
          <div class="data-table-container">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Tipe</th>
                  <th>Nominal</th>
                  <th>Saldo Akhir</th>
                  <th>Keterangan</th>
                </tr>
              </thead>
              <tbody>
                ${wled.map(w => `
                  <tr>
                    <td>${new Date(w.created_at).toLocaleDateString('id-ID')}</td>
                    <td><strong style="color:${w.type.includes('credit') ? 'var(--success)' : 'var(--accent-red)'}">${w.type}</strong></td>
                    <td>${formatRupiah(w.amount)}</td>
                    <td><strong>${formatRupiah(w.balance_after)}</strong></td>
                    <td>${w.note}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  },

  openComplaintModal(orderId) {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">⚠️ Ajukan Komplain / Refund</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>
          <div style="padding:20px;">
            <div class="form-group">
              <label class="form-label">Alasan Komplain</label>
              <select id="complaint-reason-select" class="form-select">
                <option value="Barang rusak / bocor">Barang rusak / bocor</option>
                <option value="Barang kadaluwarsa">Barang kadaluwarsa</option>
                <option value="Barang kurang / tertinggal">Barang kurang / tertinggal</option>
                <option value="Salah varian / rasa">Salah varian / rasa</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Rincian & Keterangan</label>
              <textarea id="complaint-details-input" class="form-input" rows="3" placeholder="Jelaskan kendala yang dialami..."></textarea>
            </div>
            <button class="btn-checkout-submit" onclick="app.submitComplaint('${orderId}')">
              Kirim Komplain ke Admin Toko
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async submitComplaint(orderId) {
    const reason = document.getElementById('complaint-reason-select').value;
    const details = document.getElementById('complaint-details-input').value;

    try {
      const res = await fetch('/api/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          user_id: appState.currentUser.id,
          reason, details
        })
      });
      if (res.ok) {
        alert('Komplain berhasil diajukan. Admin toko akan meninjau dan menyelesaikan permohonan refund Anda.');
        this.closeModal();
        this.openOrderTracker(orderId);
      }
    } catch (err) {
      alert('Gagal mengirim komplain: ' + err.message);
    }
  },

  openReviewModal(orderId) {
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal-overlay" onclick="app.closeModal(event)">
        <div class="modal-content-card" style="max-width:440px;" onclick="event.stopPropagation()">
          <div class="drawer-header" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
            <div class="drawer-title">⭐ Beri Rating & Ulasan</div>
            <button class="modal-close-btn" onclick="app.closeModal()" style="position:static; width:30px; height:30px; font-size:0.9rem;">✕</button>
          </div>
          <div style="padding:20px;">
            <div class="form-group">
              <label class="form-label">Kualitas Produk Minimarket (1-5 Bintang)</label>
              <select id="review-prod-rating" class="form-select">
                <option value="5">⭐⭐⭐⭐⭐ Sangat Bagus & Segar</option>
                <option value="4">⭐⭐⭐⭐ Bagus</option>
                <option value="3">⭐⭐⭐ Cukup</option>
                <option value="2">⭐⭐ Kurang</option>
                <option value="1">⭐ Buruk</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Pelayanan Kurir Pengantar (1-5 Bintang)</label>
              <select id="review-cour-rating" class="form-select">
                <option value="5">⭐⭐⭐⭐⭐ Cepat & Ramah</option>
                <option value="4">⭐⭐⭐⭐ Baik</option>
                <option value="3">⭐⭐⭐ Standar</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Komentar Ulasan</label>
              <textarea id="review-comment" class="form-input" rows="2" placeholder="Bagikan pengalaman belanja Anda..."></textarea>
            </div>
            <button class="btn-checkout-submit" onclick="app.submitReview('${orderId}')">
              Kirim Ulasan
            </button>
          </div>
        </div>
      </div>
    `;
  },

  async submitReview(orderId) {
    const prodRating = document.getElementById('review-prod-rating').value;
    const courRating = document.getElementById('review-cour-rating').value;
    const comment = document.getElementById('review-comment').value;

    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          user_id: appState.currentUser.id,
          product_rating: prodRating,
          courier_rating: courRating,
          comment
        })
      });
      if (res.ok) {
        alert('Terima kasih atas ulasan dan rating Anda!');
        this.closeModal();
        this.openOrderTracker(orderId);
      }
    } catch (err) {
      alert('Gagal mengirim ulasan: ' + err.message);
    }
  },

  showWishlistModal() {
    alert('Daftar Favorit Saya: Semua produk yang Anda sukai tersimpan aman di akun Anda.');
  },

  navigateHome() {
    this.navigateTab('home');
  }
};

// Start application on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
