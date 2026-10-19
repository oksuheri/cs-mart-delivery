#!/usr/bin/env python3
"""
CS Mart Delivery - Backend Server
Provides REST API, SQLite database with ACID transactions and append-only ledger,
and static file serving for the Progressive Web App (PWA).
"""

import os
import sys
import json
import sqlite3
import datetime
import urllib.parse
import base64
import ssl
import threading
import subprocess
import re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get('PORT', 8000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DB_PATH = os.path.join(BASE_DIR, "cs_mart.db")
TUNNEL_URL = None

def get_active_tunnel_url():
    global TUNNEL_URL
    if TUNNEL_URL:
        return TUNNEL_URL
    if os.environ.get('RENDER_EXTERNAL_URL'):
        TUNNEL_URL = os.environ.get('RENDER_EXTERNAL_URL').rstrip('/')
        return TUNNEL_URL
    tunnel_file = os.path.join(BASE_DIR, "tunnel_url.txt")
    if os.path.exists(tunnel_file):
        try:
            with open(tunnel_file) as f:
                content = f.read().strip()
                if content.startswith("https://"):
                    TUNNEL_URL = content
                    return TUNNEL_URL
        except Exception:
            pass
    return None

def start_cloudflared_tunnel():
    bin_path = os.path.join(BASE_DIR, "cloudflared")
    if not os.path.exists(bin_path):
        return

    # Check if cloudflared is already running
    try:
        res = subprocess.run(["pgrep", "-f", "cloudflared tunnel"], capture_output=True, text=True)
        if res.stdout.strip():
            print("Existing cloudflared tunnel detected.")
            get_active_tunnel_url()
            return
    except Exception:
        pass

    def _worker():
        global TUNNEL_URL
        try:
            proc = subprocess.Popen(
                [bin_path, "tunnel", "--url", f"http://127.0.0.1:{PORT}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            for line in proc.stdout:
                m = re.search(r'https://[a-zA-Z0-9.-]+\.trycloudflare\.com', line)
                if m:
                    TUNNEL_URL = m.group(0)
                    print(f"CS Mart 1-Click Install Public HTTPS URL: {TUNNEL_URL}")
                    with open(os.path.join(BASE_DIR, "tunnel_url.txt"), "w") as f:
                        f.write(TUNNEL_URL)
        except Exception as e:
            print("[Cloudflared Error]:", e)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

# Add Apple configuration profile MIME type
SimpleHTTPRequestHandler.extensions_map['.mobileconfig'] = 'application/x-apple-aspen-config'
SimpleHTTPRequestHandler.extensions_map['.json'] = 'application/json'

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()

    # Tables
    c.executescript('''
    CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        phone TEXT,
        operating_hours TEXT,
        delivery_radius_km REAL DEFAULT 15.0,
        base_fare INTEGER DEFAULT 8000,
        per_km_fare INTEGER DEFAULT 2500,
        is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        role TEXT NOT NULL, -- 'consumer', 'store_admin', 'courier', 'central_admin'
        store_id TEXT,      -- For store_admin & courier
        tier TEXT DEFAULT 'Silver', -- Silver, Gold, Platinum
        points INTEGER DEFAULT 0,
        wallet_balance INTEGER DEFAULT 0,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS addresses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address_text TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        notes TEXT,
        is_primary INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        unit TEXT NOT NULL,
        price INTEGER NOT NULL,
        old_price INTEGER,
        stock INTEGER NOT NULL DEFAULT 0,
        sold_count INTEGER DEFAULT 0,
        description TEXT,
        images_json TEXT NOT NULL, -- JSON array of image URLs
        is_discount INTEGER DEFAULT 0,
        is_featured INTEGER DEFAULT 0,
        is_free_shipping INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        courier_id TEXT,
        status TEXT NOT NULL, -- pending_payment, paid, processing, packed, awaiting_courier, assigned, picked_up, in_transit, delivered, completed, cancelled, complaint, refunded
        subtotal INTEGER NOT NULL,
        discount_amount INTEGER DEFAULT 0,
        delivery_fee INTEGER NOT NULL,
        total_amount INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        address_snapshot TEXT NOT NULL,
        order_notes TEXT,
        delivery_distance_km REAL DEFAULT 0,
        courier_lat REAL,
        courier_lng REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (store_id) REFERENCES stores(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        product_price INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        item_note TEXT,
        image_url TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS order_status_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS order_chats (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL, -- 'consumer' or 'courier'
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS complaints (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL, -- 'pending', 'resolved_refund', 'rejected'
        refund_amount INTEGER DEFAULT 0,
        resolution_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'credit_topup', 'debit_order', 'credit_refund', 'adjustment'
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reference_id TEXT, -- topup code or order id
        actor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS point_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'earn', 'redeem', 'reversal'
        points INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        order_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cash_topups (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL, -- 'pending_cash', 'confirmed', 'cancelled', 'expired'
        confirmed_by TEXT,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    CREATE TABLE IF NOT EXISTS promo_banners (
        id TEXT PRIMARY KEY,
        store_id TEXT,
        title TEXT NOT NULL,
        subtitle TEXT,
        image_url TEXT NOT NULL,
        link_target TEXT,
        sort_order INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS promo_popups (
        id TEXT PRIMARY KEY,
        store_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        cta_text TEXT DEFAULT 'Lihat Promo',
        cta_target TEXT DEFAULT 'promo',
        is_active INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tier_settings (
        id TEXT PRIMARY KEY,
        store_id TEXT, -- NULL for global/network default
        silver_min INTEGER DEFAULT 0,
        gold_min INTEGER DEFAULT 500000,
        platinum_min INTEGER DEFAULT 1500000,
        evaluation_months INTEGER DEFAULT 12,
        updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        product_rating INTEGER NOT NULL,
        courier_rating INTEGER NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    ''')

    # Seed data if empty
    res = c.execute("SELECT COUNT(*) FROM stores").fetchone()[0]
    if res == 0:
        seed_data(c)

    conn.commit()
    conn.close()

def seed_data(c):
    now = datetime.datetime.now().isoformat()

    # Stores
    c.execute('''
    INSERT INTO stores (id, name, address, lat, lng, phone, operating_hours, delivery_radius_km, base_fare, per_km_fare, is_active)
    VALUES 
    ('store-kemang', 'CS Mart Kemang', 'Jl. Kemang Raya No. 45, Jakarta Selatan', -6.2750, 106.8150, '021-7198822', '07:00 - 22:00', 12.0, 8000, 2500, 1),
    ('store-sudirman', 'CS Mart Sudirman', 'Jl. Jend. Sudirman Kav. 21, Jakarta Pusat', -6.2088, 106.8227, '021-5259900', '06:30 - 23:00', 15.0, 9000, 2500, 1)
    ''')

    # Users
    c.execute('''
    INSERT INTO users (id, name, email, phone, role, store_id, tier, points, wallet_balance, created_at)
    VALUES
    ('usr-siti', 'Siti Rahma', 'siti.rahma@gmail.com', '081234567890', 'consumer', NULL, 'Gold', 3450, 125000, ?),
    ('usr-rian', 'Rian Hendra (Admin Toko Kemang)', 'rian.kemang@csmart.id', '081399881122', 'store_admin', 'store-kemang', 'Silver', 0, 0, ?),
    ('usr-dewi', 'Dewi Lestari (Admin Toko Sudirman)', 'dewi.sudirman@csmart.id', '081377665544', 'store_admin', 'store-sudirman', 'Silver', 0, 0, ?),
    ('usr-budi', 'Budi Santoso (Kurir Toko Kemang)', 'budi.courier@csmart.id', '081511223344', 'courier', 'store-kemang', 'Silver', 0, 0, ?),
    ('usr-admin-pusat', 'Admin Pusat CS Mart', 'admin.pusat@csmart.id', '081100099988', 'central_admin', NULL, 'Platinum', 0, 0, ?)
    ''', (now, now, now, now, now))

    # Initial ledger entry for consumer wallet & points
    c.execute('''
    INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
    VALUES ('wled-init', 'usr-siti', 'credit_topup', 125000, 125000, 'INIT-SEED', 'System Seed', 'Saldo awal akun demo', ?)
    ''', (now,))

    c.execute('''
    INSERT INTO point_ledger (id, user_id, type, points, balance_after, order_id, note, created_at)
    VALUES ('pled-init', 'usr-siti', 'earn', 3450, 3450, 'INIT-ORDER', 'Poin akumulasi transaksi sebelumnya', ?)
    ''', (now,))

    # Addresses for consumer
    c.execute('''
    INSERT INTO addresses (id, user_id, label, recipient_name, phone, address_text, lat, lng, notes, is_primary)
    VALUES
    ('addr-home', 'usr-siti', 'Rumah', 'Siti Rahma', '081234567890', 'Jl. Bangka II No. 18, Mampang Prapatan, Jakarta Selatan', -6.2550, 106.8200, 'Pagar hitam, bel dekat pintu masuk', 1),
    ('addr-office', 'usr-siti', 'Kantor', 'Siti Rahma', '081234567890', 'Gedung Menara Mandiri Lt. 8, Jl. Jend. Sudirman', -6.2150, 106.8120, 'Titip di lobby resepsionis lantai 1', 0)
    ''')

    # Products for both stores
    # Images will include realistic grocery photos and multiple angles
    products_kemang = [
        ('prod-k-1', 'store-kemang', 'SND-001', 'Indomie Goreng Spesial 85g', 'Makanan & Camilan', 'Bungkus', 3200, 3500, 150, 520,
         'Mi instan goreng legendaris dengan bumbu gurih dan bawang goreng renyah.',
         json.dumps([
             'https://images.unsplash.com/photo-1612927601601-6638404737ce?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 0),
        ('prod-k-2', 'store-kemang', 'DRK-001', 'Indomilk Full Cream Susu UHT 1000ml', 'Minuman Segar', 'Kotak', 19500, 22000, 45, 180,
         'Susu segar bergizi tinggi dengan kalsium dan vitamin D lengkap untuk keluarga.',
         json.dumps([
             'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 1),
        ('prod-k-3', 'store-kemang', 'OIL-001', 'Minyak Goreng Bimoli Klasik 2 Liter', 'Kebutuhan Dapur', 'Pouch', 36900, 41000, 60, 240,
         'Minyak kelapa sawit murni berkualitas tinggi membuat masakan lebih renyah dan gurih tahan lama.',
         json.dumps([
             'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1546548970-71785318a17b?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 1),
        ('prod-k-4', 'store-kemang', 'BRD-001', 'Sari Roti Roti Tawar Spesial Jumbo', 'Roti & Sarapan', 'Bungkus', 16500, 18000, 25, 95,
         'Roti tawar lembut kaya serat cocok untuk sarapan bernutrisi setiap hari.',
         json.dumps([
             'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1586444248902-2f64eddc13df?auto=format&fit=crop&w=600&q=80'
         ]), 1, 0, 0),
        ('prod-k-5', 'store-kemang', 'FRT-001', 'Pisang Cavendish Sunpride 1 Sisir', 'Buah & Sayur', 'Sisir', 24500, 28000, 30, 110,
         'Pisang cavendish segar manis mulus kaya kalium dan energi harian.',
         json.dumps([
             'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1603833665858-e61d17a86224?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 0),
        ('prod-k-6', 'store-kemang', 'EGG-001', 'Telur Ayam Negeri Segar Isi 10 Butir', 'Kebutuhan Dapur', 'Pack', 27000, 30000, 40, 175,
         'Telur omega pilihan bebas residu antibiotik, bersih dan segar setiap pagi.',
         json.dumps([
             'https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1516448620398-c5f44bf9f441?auto=format&fit=crop&w=600&q=80'
         ]), 1, 0, 1),
        ('prod-k-7', 'store-kemang', 'SNK-001', 'Chitato Sapi Panggang 68g', 'Makanan & Camilan', 'Bungkus', 11500, 12500, 80, 310,
         'Keripik kentang bergelombang renyah dengan rasa sapi panggang otentik.',
         json.dumps([
             'https://images.unsplash.com/photo-1566478989037-eec170784d0b?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1621447504864-d8686e12698c?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 0),
        ('prod-k-8', 'store-kemang', 'TEA-001', 'Teh Kotak Jasmine 300ml (Isi 3)', 'Minuman Segar', 'Bundle', 12000, 13500, 70, 205,
         'Minuman teh melati asli dengan daun teh pilihan menyegarkan tenggorokan.',
         json.dumps([
             'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=600&q=80'
         ]), 1, 0, 0),
        ('prod-k-9', 'store-kemang', 'RCE-001', 'Beras Ramos Super Premium 5kg', 'Kebutuhan Dapur', 'Karung', 74000, 79000, 35, 140,
         'Beras putih pulen wangi alami tanpa pengawet atau pemutih.',
         json.dumps([
             'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?auto=format&fit=crop&w=600&q=80'
         ]), 1, 1, 1),
        ('prod-k-10', 'store-kemang', 'CLN-001', 'Rinso Molto Rose Fresh 770g', 'Perawatan Rumah', 'Pouch', 21500, 24000, 50, 130,
         'Deterjen konsentrat penghilang noda membandel dengan keharuman bunga rose mewah.',
         json.dumps([
             'https://images.unsplash.com/photo-1583947215259-38e31be8751f?auto=format&fit=crop&w=600&q=80',
             'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?auto=format&fit=crop&w=600&q=80'
         ]), 1, 0, 0)
    ]

    for p in products_kemang:
        c.execute('''
        INSERT INTO products (id, store_id, sku, name, category, unit, price, old_price, stock, sold_count, description, images_json, is_discount, is_featured, is_free_shipping, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ''', p)

    # Clone similar products for store-sudirman with slightly different stock and price
    for p in products_kemang:
        new_id = p[0].replace('prod-k-', 'prod-s-')
        c.execute('''
        INSERT INTO products (id, store_id, sku, name, category, unit, price, old_price, stock, sold_count, description, images_json, is_discount, is_featured, is_free_shipping, is_active)
        VALUES (?, 'store-sudirman', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ''', (new_id, p[2], p[3], p[4], p[5], p[6], p[7], p[8] + 15, p[9], p[10], p[11], p[12], p[13], p[14]))

    # Seed an initial completed order for Siti to show history & tier spending
    order_time = (datetime.datetime.now() - datetime.timedelta(days=2)).isoformat()
    c.execute('''
    INSERT INTO orders (id, store_id, user_id, courier_id, status, subtotal, discount_amount, delivery_fee, total_amount, payment_method, payment_status, address_snapshot, order_notes, delivery_distance_km, courier_lat, courier_lng, created_at, updated_at)
    VALUES
    ('ORD-20261017-001', 'store-kemang', 'usr-siti', 'usr-budi', 'completed', 115000, 10000, 8000, 113000, 'Saldo CS Pay', 'paid', 'Jl. Bangka II No. 18, Mampang Prapatan', 'Tolong jangan dibanting', 2.8, -6.2550, 106.8200, ?, ?)
    ''', (order_time, order_time))

    c.execute('''
    INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity, item_note, image_url)
    VALUES
    ('item-1', 'ORD-20261017-001', 'prod-k-2', 'Indomilk Full Cream Susu UHT 1000ml', 19500, 2, 'Cari exp terjauh ya', 'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=600&q=80'),
    ('item-2', 'ORD-20261017-001', 'prod-k-3', 'Minyak Goreng Bimoli Klasik 2 Liter', 36900, 2, 'Pouch jangan bocor', 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=600&q=80')
    ''')

    c.execute('''
    INSERT INTO order_status_events (id, order_id, status, actor, actor_role, note, created_at)
    VALUES
    ('ev-1', 'ORD-20261017-001', 'pending_payment', 'Siti Rahma', 'consumer', 'Pesanan dibuat', ?),
    ('ev-2', 'ORD-20261017-001', 'paid', 'System', 'system', 'Pembayaran via Saldo CS Pay terkonfirmasi', ?),
    ('ev-3', 'ORD-20261017-001', 'processing', 'Rian Hendra', 'store_admin', 'Toko mulai menyiapkan barang', ?),
    ('ev-4', 'ORD-20261017-001', 'packed', 'Rian Hendra', 'store_admin', 'Barang selesai dikemas rapat', ?),
    ('ev-5', 'ORD-20261017-001', 'assigned', 'Rian Hendra', 'store_admin', 'Menugaskan kurir Budi Santoso', ?),
    ('ev-6', 'ORD-20261017-001', 'picked_up', 'Budi Santoso', 'courier', 'Kurir mengambil pesanan di toko', ?),
    ('ev-7', 'ORD-20261017-001', 'in_transit', 'Budi Santoso', 'courier', 'Kurir dalam perjalanan ke alamat tujuan', ?),
    ('ev-8', 'ORD-20261017-001', 'delivered', 'Budi Santoso', 'courier', 'Serah terima barang sukses', ?),
    ('ev-9', 'ORD-20261017-001', 'completed', 'Siti Rahma', 'consumer', 'Pesanan selesai & dikonfirmasi konsumen', ?)
    ''', (order_time, order_time, order_time, order_time, order_time, order_time, order_time, order_time, order_time))

    # Add chats on this order to show conversation history
    c.execute('''
    INSERT INTO order_chats (id, order_id, sender_id, sender_name, sender_role, message, created_at)
    VALUES
    ('chat-1', 'ORD-20261017-001', 'usr-budi', 'Budi Santoso', 'courier', 'Halo Kak Siti, pesanan sudah saya ambil dari toko CS Mart Kemang dan segera diantar ya.', ?),
    ('chat-2', 'ORD-20261017-001', 'usr-siti', 'Siti Rahma', 'consumer', 'Baik Mas Budi, nanti tolong titip di teras samping dekat pintu ya.', ?)
    ''', (order_time, order_time))

    # Promo banners
    c.execute('''
    INSERT INTO promo_banners (id, store_id, title, subtitle, image_url, link_target, sort_order, is_active)
    VALUES
    ('ban-1', NULL, 'Diskon Spesial Hingga 50%', 'Belanja kebutuhan dapur dan camilan hemat hari ini', '/assets/promo_banner_1.jpg', 'discount', 1, 1),
    ('ban-2', NULL, 'Gratis Ongkir Se-Jakarta', 'Nikmati gratis ongkos kirim minimum belanja Rp 50.000', 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=80', 'free_shipping', 2, 1),
    ('ban-3', NULL, 'Poin Member Dobel 2x', 'Dapatkan poin berlipat ganda setiap transaksi akhir pekan', 'https://images.unsplash.com/photo-1580828343064-fde4fc206bc6?auto=format&fit=crop&w=1200&q=80', 'member', 3, 1)
    ''')

    # Promo popup campaign
    c.execute('''
    INSERT INTO promo_popups (id, store_id, title, content, image_url, cta_text, cta_target, is_active, priority)
    VALUES
    ('pop-1', NULL, 'Flash Sale Gajian CS Mart!', 'Dapatkan cashback koin loyalitas dan gratis ongkir khusus belanja hari ini dengan kode HEMAT50', '/assets/promo_banner_1.jpg', 'Belanja Sekarang', 'discount', 1, 1)
    ''')

    # Tier settings default
    c.execute('''
    INSERT INTO tier_settings (id, store_id, silver_min, gold_min, platinum_min, evaluation_months, updated_at)
    VALUES ('tier-global', NULL, 0, 500000, 1500000, 12, ?)
    ''', (now,))

    # Cash topup sample
    c.execute('''
    INSERT INTO cash_topups (id, code, user_id, store_id, amount, status, confirmed_by, created_at, confirmed_at)
    VALUES
    ('top-101', 'TOPUP-KMG-9821', 'usr-siti', 'store-kemang', 100000, 'confirmed', 'Rian Hendra (Kasir)', ?, ?)
    ''', (order_time, order_time))

    # Audit log
    c.execute('''
    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
    VALUES
    ('aud-1', 'INITIAL_SYSTEM_SETUP', 'SYSTEM', 'GLOBAL', 'usr-admin-pusat', 'Admin Pusat CS Mart', 'Inisialisasi sistem jaringan CS Mart Delivery v1.0', ?)
    ''', (now,))


class CSMartHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def _send_json(self, data, status_code=200):
        body = json.dumps(data, default=str).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def _read_body_json(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                return {}
            raw = self.wfile.read(length) if hasattr(self, 'read') else self.rfile.read(length)
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def serve_ios_mobileconfig(self):
        try:
            icon_path = os.path.join(PUBLIC_DIR, 'assets', 'icon-apple-touch.png')
            if not os.path.exists(icon_path):
                icon_path = os.path.join(PUBLIC_DIR, 'assets', 'logo.jpg')
            with open(icon_path, 'rb') as f:
                icon_b64 = base64.b64encode(f.read()).decode('utf-8')

            url = get_active_tunnel_url()
            if url:
                target_url = f"{url}/?source=pwa"
            else:
                host = self.headers.get('Host', '127.0.0.1:8443')
                hostname = host.split(':')[0]
                target_url = f"https://{hostname}:8443/?source=pwa"

            mobileconfig = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>FullScreen</key>
            <true/>
            <key>Icon</key>
            <data>{icon_b64}</data>
            <key>IsRemovable</key>
            <true/>
            <key>Label</key>
            <string>CS Mart Delivery</string>
            <key>PayloadDescription</key>
            <string>CS Mart Delivery Minimarket Web App</string>
            <key>PayloadDisplayName</key>
            <string>CS Mart Delivery</string>
            <key>PayloadIdentifier</key>
            <string>id.csmart.delivery.webclip</string>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
            <key>PayloadUUID</key>
            <string>5C52E584-931B-4E38-B549-299DF8203FE6</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>Precomposed</key>
            <true/>
            <key>URL</key>
            <string>{target_url}</string>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>CS Mart Delivery</string>
    <key>PayloadIdentifier</key>
    <string>id.csmart.delivery.profile</string>
    <key>PayloadOrganization</key>
    <string>CS Mart Minimarket Indonesia</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>98D80998-1BE1-4C54-8B62-0943A2C21564</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>"""
            content_bytes = mobileconfig.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-apple-aspen-config')
            self.send_header('Content-Disposition', 'attachment; filename="CSMartDelivery.mobileconfig"')
            self.send_header('Content-Length', str(len(content_bytes)))
            self.end_headers()
            self.wfile.write(content_bytes)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # Route iOS profile
        if path in ['/csmart.mobileconfig', '/api/pwa/ios-profile']:
            self.serve_ios_mobileconfig()
            return

        # Route API requests
        if path.startswith('/api/'):
            self.handle_api_get(path, query)
            return

        # Fallback to static files
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith('/api/'):
            body = self._read_body_json()
            self.handle_api_post(path, body)
            return
        self._send_json({"error": "Not found"}, 404)

    def handle_api_get(self, path, query):
        conn = get_db()
        c = conn.cursor()

        try:
            # 0. Active PWA 1-Click Tunnel URL
            if path == '/api/pwa/tunnel-url':
                url = get_active_tunnel_url()
                self._send_json({"success": True, "tunnel_url": url})
                return

            # 1. Stores
            if path == '/api/stores':
                stores = [dict(r) for r in c.execute("SELECT * FROM stores ORDER BY name ASC").fetchall()]
                self._send_json({"success": True, "stores": stores})
                return

            # 2. Products per store
            if path == '/api/products':
                store_id = query.get('store_id', ['store-kemang'])[0]
                category = query.get('category', [None])[0]
                filter_type = query.get('filter', [None])[0] # discount, free_shipping, featured
                sort_type = query.get('sort', ['recommended'])[0] # recommended, az, za, price_asc, price_desc
                search = query.get('q', [None])[0]

                sql = "SELECT * FROM products WHERE store_id = ? AND is_active = 1"
                params = [store_id]

                if category and category != 'Semua':
                    sql += " AND category = ?"
                    params.append(category)

                if filter_type == 'discount':
                    sql += " AND is_discount = 1"
                elif filter_type == 'free_shipping':
                    sql += " AND is_free_shipping = 1"
                elif filter_type == 'featured':
                    sql += " AND is_featured = 1"

                if search:
                    sql += " AND (name LIKE ? OR description LIKE ? OR category LIKE ?)"
                    term = f"%{search}%"
                    params.extend([term, term, term])

                # Sorting rules
                if sort_type == 'az':
                    sql += " ORDER BY name ASC"
                elif sort_type == 'za':
                    sql += " ORDER BY name DESC"
                elif sort_type == 'price_asc':
                    sql += " ORDER BY price ASC"
                elif sort_type == 'price_desc':
                    sql += " ORDER BY price DESC"
                else:
                    # recommended: featured first, then sold count desc
                    sql += " ORDER BY is_featured DESC, sold_count DESC, id ASC"

                products = []
                for r in c.execute(sql, params).fetchall():
                    d = dict(r)
                    d['images'] = json.loads(d['images_json'])
                    products.append(d)

                # Categories list
                cats = [r[0] for r in c.execute("SELECT DISTINCT category FROM products WHERE store_id = ?", (store_id,)).fetchall()]

                self._send_json({
                    "success": True,
                    "store_id": store_id,
                    "count": len(products),
                    "categories": ['Semua'] + cats,
                    "products": products,
                    "sync_time": datetime.datetime.now().isoformat()
                })
                return

            # 3. User session / profile
            if path == '/api/users/profile':
                user_id = query.get('user_id', ['usr-siti'])[0]
                user = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                if not user:
                    self._send_json({"error": "User not found"}, 404)
                    return
                d_user = dict(user)

                # Addresses
                addresses = [dict(r) for r in c.execute("SELECT * FROM addresses WHERE user_id = ?", (user_id,)).fetchall()]
                d_user['addresses'] = addresses

                # Calculate tier progress based on completed orders net spending
                spending_res = c.execute("""
                    SELECT COALESCE(SUM(total_amount), 0) FROM orders 
                    WHERE user_id = ? AND status = 'completed'
                """, (user_id,)).fetchone()[0]

                tier_settings = c.execute("SELECT * FROM tier_settings LIMIT 1").fetchone()
                gold_min = tier_settings['gold_min'] if tier_settings else 500000
                plat_min = tier_settings['platinum_min'] if tier_settings else 1500000

                d_user['spending_period'] = spending_res
                d_user['tier_gold_min'] = gold_min
                d_user['tier_plat_min'] = plat_min

                self._send_json({"success": True, "user": d_user})
                return

            # 4. List all users for role switcher
            if path == '/api/users':
                users = [dict(r) for r in c.execute("SELECT * FROM users ORDER BY role ASC, name ASC").fetchall()]
                self._send_json({"success": True, "users": users})
                return

            # 5. Orders list
            if path == '/api/orders':
                user_id = query.get('user_id', [None])[0]
                store_id = query.get('store_id', [None])[0]
                courier_id = query.get('courier_id', [None])[0]

                sql = "SELECT * FROM orders WHERE 1=1"
                params = []
                if user_id:
                    sql += " AND user_id = ?"
                    params.append(user_id)
                if store_id:
                    sql += " AND store_id = ?"
                    params.append(store_id)
                if courier_id:
                    sql += " AND courier_id = ?"
                    params.append(courier_id)

                sql += " ORDER BY created_at DESC"
                orders = []
                for r in c.execute(sql, params).fetchall():
                    od = dict(r)
                    # items
                    items = [dict(it) for it in c.execute("SELECT * FROM order_items WHERE order_id = ?", (od['id'],)).fetchall()]
                    od['items'] = items
                    # store info
                    st = c.execute("SELECT name, phone FROM stores WHERE id = ?", (od['store_id'],)).fetchone()
                    od['store_name'] = st['name'] if st else ''
                    # courier info
                    if od['courier_id']:
                        cr = c.execute("SELECT name, phone FROM users WHERE id = ?", (od['courier_id'],)).fetchone()
                        od['courier_name'] = cr['name'] if cr else ''
                        od['courier_phone'] = cr['phone'] if cr else ''
                    orders.append(od)

                self._send_json({"success": True, "orders": orders})
                return

            # 6. Order detail by ID
            if path.startswith('/api/orders/'):
                order_id = path.split('/')[3]
                if order_id.endswith('/chat'):
                    # Handled below
                    pass
                else:
                    od_row = c.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
                    if not od_row:
                        self._send_json({"error": "Order not found"}, 404)
                        return
                    od = dict(od_row)
                    od['items'] = [dict(it) for it in c.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,)).fetchall()]
                    od['timeline'] = [dict(ev) for ev in c.execute("SELECT * FROM order_status_events WHERE order_id = ? ORDER BY created_at ASC", (order_id,)).fetchall()]
                    od['chats'] = [dict(ch) for ch in c.execute("SELECT * FROM order_chats WHERE order_id = ? ORDER BY created_at ASC", (order_id,)).fetchall()]
                    
                    st = c.execute("SELECT name, phone, address, lat, lng FROM stores WHERE id = ?", (od['store_id'],)).fetchone()
                    od['store'] = dict(st) if st else {}

                    if od['courier_id']:
                        cr = c.execute("SELECT name, phone FROM users WHERE id = ?", (od['courier_id'],)).fetchone()
                        od['courier'] = dict(cr) if cr else {}

                    complaint = c.execute("SELECT * FROM complaints WHERE order_id = ?", (order_id,)).fetchone()
                    od['complaint'] = dict(complaint) if complaint else None

                    review = c.execute("SELECT * FROM reviews WHERE order_id = ?", (order_id,)).fetchone()
                    od['review'] = dict(review) if review else None

                    self._send_json({"success": True, "order": od})
                    return

            # 7. Order chat list
            if path.endswith('/chat') and path.startswith('/api/orders/'):
                order_id = path.split('/')[3]
                chats = [dict(ch) for ch in c.execute("SELECT * FROM order_chats WHERE order_id = ? ORDER BY created_at ASC", (order_id,)).fetchall()]
                self._send_json({"success": True, "order_id": order_id, "chats": chats})
                return

            # 8. Wallet and points history (Ledger)
            if path == '/api/wallet/ledger':
                user_id = query.get('user_id', ['usr-siti'])[0]
                wallet_rows = [dict(r) for r in c.execute("SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()]
                point_rows = [dict(r) for r in c.execute("SELECT * FROM point_ledger WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()]
                topups = [dict(r) for r in c.execute("SELECT * FROM cash_topups WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()]
                self._send_json({
                    "success": True,
                    "wallet_ledger": wallet_rows,
                    "point_ledger": point_rows,
                    "topups": topups
                })
                return

            # 9. Cash topup list for cashier (store admin)
            if path == '/api/cashier/topups':
                store_id = query.get('store_id', [None])[0]
                sql = """
                    SELECT t.*, u.name as user_name, u.phone as user_phone 
                    FROM cash_topups t 
                    JOIN users u ON t.user_id = u.id 
                    WHERE 1=1
                """
                params = []
                if store_id:
                    sql += " AND t.store_id = ?"
                    params.append(store_id)
                sql += " ORDER BY t.created_at DESC"
                topups = [dict(r) for r in c.execute(sql, params).fetchall()]
                self._send_json({"success": True, "topups": topups})
                return

            # 10. Promo banners & popup
            if path == '/api/promotions':
                banners = [dict(r) for r in c.execute("SELECT * FROM promo_banners WHERE is_active = 1 ORDER BY sort_order ASC").fetchall()]
                popup = c.execute("SELECT * FROM promo_popups WHERE is_active = 1 ORDER BY priority DESC LIMIT 1").fetchone()
                self._send_json({
                    "success": True,
                    "banners": banners,
                    "popup": dict(popup) if popup else None
                })
                return

            # 11. Tier settings
            if path == '/api/tier-settings':
                store_id = query.get('store_id', [None])[0]
                setting = c.execute("SELECT * FROM tier_settings LIMIT 1").fetchone()
                self._send_json({"success": True, "tier_settings": dict(setting) if setting else {}})
                return

            # 12. Courier tasks
            if path == '/api/courier/tasks':
                courier_id = query.get('courier_id', ['usr-budi'])[0]
                tasks = []
                for r in c.execute("""
                    SELECT o.*, u.name as customer_name, u.phone as customer_phone, s.name as store_name
                    FROM orders o
                    JOIN users u ON o.user_id = u.id
                    JOIN stores s ON o.store_id = s.id
                    WHERE (o.courier_id = ? OR (o.courier_id IS NULL AND o.status = 'awaiting_courier' AND o.store_id = (SELECT store_id FROM users WHERE id = ?)))
                    ORDER BY o.updated_at DESC
                """, (courier_id, courier_id)).fetchall():
                    tasks.append(dict(r))
                self._send_json({"success": True, "tasks": tasks})
                return

            # 13. Reports and Audit Logs
            if path == '/api/reports':
                store_id = query.get('store_id', [None])[0]
                
                # Base order stats
                sql = "SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as gmv FROM orders WHERE 1=1"
                params = []
                if store_id:
                    sql += " AND store_id = ?"
                    params.append(store_id)
                sql += " GROUP BY status"
                status_summary = [dict(r) for r in c.execute(sql, params).fetchall()]

                total_gmv = sum(r['gmv'] for r in status_summary if r['status'] in ('paid', 'processing', 'packed', 'assigned', 'picked_up', 'in_transit', 'delivered', 'completed'))
                completed_orders = sum(r['cnt'] for r in status_summary if r['status'] == 'completed')
                total_orders = sum(r['cnt'] for r in status_summary)

                # Recent audit logs
                audits = [dict(r) for r in c.execute("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 30").fetchall()]

                self._send_json({
                    "success": True,
                    "total_gmv": total_gmv,
                    "total_orders": total_orders,
                    "completed_orders": completed_orders,
                    "status_summary": status_summary,
                    "audit_logs": audits
                })
                return

            # 14. Complaints list for store admin
            if path == '/api/complaints':
                store_id = query.get('store_id', [None])[0]
                sql = """
                    SELECT c.*, o.total_amount, o.store_id, u.name as user_name, u.phone as user_phone
                    FROM complaints c
                    JOIN orders o ON c.order_id = o.id
                    JOIN users u ON c.user_id = u.id
                    WHERE 1=1
                """
                params = []
                if store_id:
                    sql += " AND o.store_id = ?"
                    params.append(store_id)
                sql += " ORDER BY c.created_at DESC"
                complaints = [dict(r) for r in c.execute(sql, params).fetchall()]
                self._send_json({"success": True, "complaints": complaints})
                return

            self._send_json({"error": "API route not found"}, 404)
        finally:
            conn.close()

    def handle_api_post(self, path, body):
        conn = get_db()
        c = conn.cursor()
        now = datetime.datetime.now().isoformat()

        try:
            # 1. Create Order (Checkout with server validation & snapshots)
            if path == '/api/orders':
                user_id = body.get('user_id')
                store_id = body.get('store_id')
                items = body.get('items', [])
                payment_method = body.get('payment_method', 'Saldo CS Pay')
                address_text = body.get('address_text', '')
                distance_km = float(body.get('distance_km', 2.5))
                order_notes = body.get('order_notes', '')

                if not user_id or not store_id or not items:
                    self._send_json({"error": "Data pesanan tidak lengkap"}, 400)
                    return

                # Check store status
                store = c.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
                if not store or not store['is_active']:
                    self._send_json({"error": "Toko sedang tutup atau tidak aktif"}, 400)
                    return

                # Calculate & validate items and stocks on server
                subtotal = 0
                validated_items = []
                has_free_shipping = False

                for it in items:
                    prod = c.execute("SELECT * FROM products WHERE id = ? AND store_id = ?", (it['product_id'], store_id)).fetchone()
                    if not prod:
                        self._send_json({"error": f"Produk ID {it['product_id']} tidak ditemukan di toko ini"}, 400)
                        return
                    qty = int(it.get('quantity', 1))
                    if prod['stock'] < qty:
                        self._send_json({"error": f"Stok produk {prod['name']} tidak mencukupi (sisa {prod['stock']})"}, 400)
                        return
                    
                    item_total = prod['price'] * qty
                    subtotal += item_total
                    if prod['is_free_shipping']:
                        has_free_shipping = True

                    validated_items.append({
                        "product_id": prod['id'],
                        "name": prod['name'],
                        "price": prod['price'],
                        "quantity": qty,
                        "item_note": it.get('item_note', ''),
                        "image_url": json.loads(prod['images_json'])[0] if prod['images_json'] else ''
                    })

                # Delivery fee calculation
                base_fare = store['base_fare']
                per_km_fare = store['per_km_fare']
                delivery_fee = base_fare + int(distance_km * per_km_fare)
                if has_free_shipping or subtotal >= 100000:
                    delivery_fee = 0 # Free shipping promo

                total_amount = subtotal + delivery_fee

                # Check wallet balance if payment_method is Saldo CS Pay
                user = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                if payment_method == 'Saldo CS Pay':
                    if user['wallet_balance'] < total_amount:
                        self._send_json({"error": f"Saldo CS Pay tidak cukup (Saldo: Rp {user['wallet_balance']:,}, Total: Rp {total_amount:,})"}, 400)
                        return
                    new_balance = user['wallet_balance'] - total_amount
                    c.execute("UPDATE users SET wallet_balance = ? WHERE id = ?", (new_balance, user_id))
                    # Ledger debit
                    c.execute("""
                        INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
                        VALUES (?, ?, 'debit_order', ?, ?, ?, 'Consumer Checkout', 'Pembayaran pesanan minimarket', ?)
                    """, (f"wled-{datetime.datetime.now().timestamp()}", user_id, total_amount, new_balance, f"ORD-{int(datetime.datetime.now().timestamp())}", now))

                # Decrement stock and increment sold_count
                for vit in validated_items:
                    c.execute("UPDATE products SET stock = stock - ?, sold_count = sold_count + ? WHERE id = ?", 
                              (vit['quantity'], vit['quantity'], vit['product_id']))

                order_id = f"ORD-{datetime.datetime.now().strftime('%Y%m%d')}-{int(datetime.datetime.now().timestamp()) % 10000:04d}"
                initial_status = 'paid' if payment_method in ('Saldo CS Pay', 'QRIS CS Mart (Simulasi)', 'Virtual Account (Simulasi)') else 'pending_payment'
                pay_status = 'paid' if initial_status == 'paid' else 'pending'

                c.execute("""
                    INSERT INTO orders (id, store_id, user_id, courier_id, status, subtotal, discount_amount, delivery_fee, total_amount, payment_method, payment_status, address_snapshot, order_notes, delivery_distance_km, courier_lat, courier_lng, created_at, updated_at)
                    VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (order_id, store_id, user_id, initial_status, subtotal, delivery_fee, total_amount, payment_method, pay_status, address_text, order_notes, distance_km, store['lat'], store['lng'], now, now))

                for vit in validated_items:
                    c.execute("""
                        INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity, item_note, image_url)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (f"item-{vit['product_id']}-{order_id}", order_id, vit['product_id'], vit['name'], vit['price'], vit['quantity'], vit['item_note'], vit['image_url']))

                # Status event
                c.execute("""
                    INSERT INTO order_status_events (id, order_id, status, actor, actor_role, note, created_at)
                    VALUES (?, ?, ?, ?, 'consumer', 'Pesanan berhasil dibuat', ?)
                """, (f"ev-init-{order_id}", order_id, initial_status, user['name'], now))

                # Audit log
                c.execute("""
                    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                    VALUES (?, 'ORDER_CREATED', 'ORDER', ?, ?, ?, ?, ?)
                """, (f"aud-{order_id}", order_id, user_id, user['name'], f"Pesanan {order_id} total Rp {total_amount:,} via {payment_method}", now))

                conn.commit()
                self._send_json({"success": True, "order_id": order_id, "status": initial_status, "total_amount": total_amount})
                return

            # 2. Update Order Status (Store admin / Courier / Consumer)
            if path == '/api/orders/status':
                order_id = body.get('order_id')
                new_status = body.get('status')
                actor_id = body.get('actor_id', 'system')
                actor_role = body.get('actor_role', 'store_admin')
                courier_id = body.get('courier_id')
                note = body.get('note', '')

                od = c.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
                if not od:
                    self._send_json({"error": "Pesanan tidak ditemukan"}, 404)
                    return

                actor_user = c.execute("SELECT name FROM users WHERE id = ?", (actor_id,)).fetchone()
                actor_name = actor_user['name'] if actor_user else 'System'

                update_fields = ["status = ?", "updated_at = ?"]
                params = [new_status, now]

                if courier_id:
                    update_fields.append("courier_id = ?")
                    params.append(courier_id)

                # Move courier location slightly if in_transit
                if new_status == 'in_transit':
                    st = c.execute("SELECT lat, lng FROM stores WHERE id = ?", (od['store_id'],)).fetchone()
                    if st:
                        # slightly closer to delivery
                        update_fields.append("courier_lat = ?")
                        update_fields.append("courier_lng = ?")
                        params.append(st['lat'] + 0.005)
                        params.append(st['lng'] + 0.004)

                params.append(order_id)
                c.execute(f"UPDATE orders SET {', '.join(update_fields)} WHERE id = ?", params)

                # Log status event
                c.execute("""
                    INSERT INTO order_status_events (id, order_id, status, actor, actor_role, note, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (f"ev-{new_status}-{datetime.datetime.now().timestamp()}", order_id, new_status, actor_name, actor_role, note or f"Status diperbarui menjadi {new_status}", now))

                # If status is 'completed', reward points to customer (1 point per Rp 1.000)
                if new_status == 'completed' and od['status'] != 'completed':
                    earned_points = int(od['total_amount'] / 1000)
                    if earned_points > 0:
                        c.execute("UPDATE users SET points = points + ? WHERE id = ?", (earned_points, od['user_id']))
                        user_now = c.execute("SELECT points FROM users WHERE id = ?", (od['user_id'],)).fetchone()
                        c.execute("""
                            INSERT INTO point_ledger (id, user_id, type, points, balance_after, order_id, note, created_at)
                            VALUES (?, ?, 'earn', ?, ?, ?, 'Reward poin penyelesaian pesanan', ?)
                        """, (f"pled-{order_id}", od['user_id'], earned_points, user_now['points'], order_id, now))

                conn.commit()
                self._send_json({"success": True, "order_id": order_id, "status": new_status})
                return

            # 3. Send Order Chat Message
            if path == '/api/orders/chat':
                order_id = body.get('order_id')
                sender_id = body.get('sender_id')
                sender_role = body.get('sender_role', 'consumer')
                message = body.get('message', '').strip()

                if not order_id or not sender_id or not message:
                    self._send_json({"error": "Pesan tidak boleh kosong"}, 400)
                    return

                sender = c.execute("SELECT name FROM users WHERE id = ?", (sender_id,)).fetchone()
                sender_name = sender['name'] if sender else 'User'

                chat_id = f"chat-{datetime.datetime.now().timestamp()}"
                c.execute("""
                    INSERT INTO order_chats (id, order_id, sender_id, sender_name, sender_role, message, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (chat_id, order_id, sender_id, sender_name, sender_role, message, now))

                conn.commit()
                self._send_json({"success": True, "chat_id": chat_id, "created_at": now})
                return

            # 4. Request Cash Topup (Consumer)
            if path == '/api/wallet/topup/request':
                user_id = body.get('user_id')
                store_id = body.get('store_id', 'store-kemang')
                amount = int(body.get('amount', 50000))

                if amount < 10000:
                    self._send_json({"error": "Nominal top up minimal Rp 10.000"}, 400)
                    return

                topup_code = f"TOPUP-{store_id.split('-')[-1].upper()}-{int(datetime.datetime.now().timestamp()) % 10000:04d}"
                topup_id = f"top-{datetime.datetime.now().timestamp()}"

                c.execute("""
                    INSERT INTO cash_topups (id, code, user_id, store_id, amount, status, confirmed_by, created_at)
                    VALUES (?, ?, ?, ?, ?, 'pending_cash', NULL, ?)
                """, (topup_id, topup_code, user_id, store_id, amount, now))

                conn.commit()
                self._send_json({
                    "success": True,
                    "topup_id": topup_id,
                    "code": topup_code,
                    "amount": amount,
                    "status": "pending_cash"
                })
                return

            # 5. Confirm Cash Topup (Cashier / Store Admin only)
            if path == '/api/wallet/topup/confirm':
                code = body.get('code')
                cashier_id = body.get('cashier_id')

                topup = c.execute("SELECT * FROM cash_topups WHERE code = ?", (code,)).fetchone()
                if not topup:
                    self._send_json({"error": "Kode top up tidak valid"}, 404)
                    return

                if topup['status'] == 'confirmed':
                    self._send_json({"error": "Kode top up sudah pernah dikonfirmasi sebelumnya!"}, 400)
                    return

                cashier = c.execute("SELECT name FROM users WHERE id = ?", (cashier_id,)).fetchone()
                cashier_name = cashier['name'] if cashier else 'Kasir Toko'

                # Update topup status
                c.execute("""
                    UPDATE cash_topups SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?
                """, (cashier_name, now, topup['id']))

                # Credit user wallet
                c.execute("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?", (topup['amount'], topup['user_id']))
                user_now = c.execute("SELECT wallet_balance, name FROM users WHERE id = ?", (topup['user_id'],)).fetchone()

                # Add to ledger
                c.execute("""
                    INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
                    VALUES (?, ?, 'credit_topup', ?, ?, ?, ?, 'Top up tunai kasir minimarket', ?)
                """, (f"wled-{datetime.datetime.now().timestamp()}", topup['user_id'], topup['amount'], user_now['wallet_balance'], topup['code'], cashier_name, now))

                # Audit log
                c.execute("""
                    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                    VALUES (?, 'CASH_TOPUP_CONFIRMED', 'WALLET', ?, ?, ?, ?, ?)
                """, (f"aud-{topup['id']}", topup['code'], cashier_id, cashier_name, f"Konfirmasi top up tunai Rp {topup['amount']:,} untuk konsumen {user_now['name']}", now))

                conn.commit()
                self._send_json({"success": True, "code": code, "amount": topup['amount'], "new_balance": user_now['wallet_balance']})
                return

            # 6. Submit Complaint (Consumer)
            if path == '/api/complaints':
                order_id = body.get('order_id')
                user_id = body.get('user_id')
                reason = body.get('reason', 'Barang rusak / bocor')
                details = body.get('details', '')

                od = c.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
                if not od:
                    self._send_json({"error": "Pesanan tidak ditemukan"}, 404)
                    return

                complaint_id = f"cmp-{int(datetime.datetime.now().timestamp())}"
                c.execute("""
                    INSERT INTO complaints (id, order_id, user_id, reason, details, status, refund_amount, resolution_notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
                """, (complaint_id, order_id, user_id, reason, details, now, now))

                c.execute("UPDATE orders SET status = 'complaint', updated_at = ? WHERE id = ?", (now, order_id))
                c.execute("""
                    INSERT INTO order_status_events (id, order_id, status, actor, actor_role, note, created_at)
                    VALUES (?, ?, 'complaint', 'Konsumen', 'consumer', ?, ?)
                """, (f"ev-cmp-{complaint_id}", order_id, f"Komplain diajukan: {reason}", now))

                conn.commit()
                self._send_json({"success": True, "complaint_id": complaint_id})
                return

            # 7. Resolve Complaint & Refund (Store Admin)
            if path == '/api/complaints/resolve':
                complaint_id = body.get('complaint_id')
                admin_id = body.get('admin_id')
                decision = body.get('decision') # 'refund_wallet', 'rejected', 'resend'
                refund_amount = int(body.get('refund_amount', 0))
                notes = body.get('notes', '')

                cmp = c.execute("SELECT * FROM complaints WHERE id = ?", (complaint_id,)).fetchone()
                if not cmp:
                    self._send_json({"error": "Komplain tidak ditemukan"}, 404)
                    return

                admin = c.execute("SELECT name FROM users WHERE id = ?", (admin_id,)).fetchone()
                admin_name = admin['name'] if admin else 'Admin Toko'

                if decision == 'refund_wallet':
                    # Credit wallet
                    c.execute("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?", (refund_amount, cmp['user_id']))
                    u = c.execute("SELECT wallet_balance FROM users WHERE id = ?", (cmp['user_id'],)).fetchone()
                    
                    # Ledger entry
                    c.execute("""
                        INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
                        VALUES (?, ?, 'credit_refund', ?, ?, ?, ?, ?, ?)
                    """, (f"wled-{datetime.datetime.now().timestamp()}", cmp['user_id'], refund_amount, u['wallet_balance'], cmp['order_id'], admin_name, f"Refund komplain: {notes}", now))

                    c.execute("""
                        UPDATE complaints SET status = 'resolved_refund', refund_amount = ?, resolution_notes = ?, updated_at = ? WHERE id = ?
                    """, (refund_amount, notes, now, complaint_id))

                    c.execute("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?", (now, cmp['order_id']))

                    c.execute("""
                        INSERT INTO order_status_events (id, order_id, status, actor, actor_role, note, created_at)
                        VALUES (?, ?, 'refunded', ?, 'store_admin', ?, ?)
                    """, (f"ev-ref-{complaint_id}", cmp['order_id'], admin_name, f"Refund disetujui sebesar Rp {refund_amount:,}", now))
                else:
                    c.execute("""
                        UPDATE complaints SET status = 'rejected', resolution_notes = ?, updated_at = ? WHERE id = ?
                    """, (notes, now, complaint_id))
                    c.execute("UPDATE orders SET status = 'completed', updated_at = ? WHERE id = ?", (now, cmp['order_id']))

                conn.commit()
                self._send_json({"success": True, "complaint_id": complaint_id, "decision": decision})
                return

            # 8. Submit Review
            if path == '/api/reviews':
                order_id = body.get('order_id')
                user_id = body.get('user_id')
                prod_rating = int(body.get('product_rating', 5))
                cour_rating = int(body.get('courier_rating', 5))
                comment = body.get('comment', '')

                user = c.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
                user_name = user['name'] if user else 'Konsumen'

                c.execute("""
                    INSERT INTO reviews (id, order_id, user_id, user_name, product_rating, courier_rating, comment, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (f"rev-{datetime.datetime.now().timestamp()}", order_id, user_id, user_name, prod_rating, cour_rating, comment, now))

                conn.commit()
                self._send_json({"success": True})
                return

            # 9. Admin Manage Products (Create / Update / Delete)
            if path == '/api/admin/products':
                action = body.get('action', 'save') # 'save' or 'delete'
                admin_id = body.get('admin_id')
                admin = c.execute("SELECT name FROM users WHERE id = ?", (admin_id,)).fetchone()
                admin_name = admin['name'] if admin else 'Store Admin'

                if action == 'delete':
                    prod_id = body.get('id')
                    c.execute("UPDATE products SET is_active = 0 WHERE id = ?", (prod_id,))
                    c.execute("""
                        INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                        VALUES (?, 'PRODUCT_DELETED', 'PRODUCT', ?, ?, ?, 'Produk dinonaktifkan dari katalog', ?)
                    """, (f"aud-{datetime.datetime.now().timestamp()}", prod_id, admin_id, admin_name, now))
                    conn.commit()
                    self._send_json({"success": True, "deleted_id": prod_id})
                    return

                # Save product
                prod_id = body.get('id')
                store_id = body.get('store_id', 'store-kemang')
                sku = body.get('sku', f"SKU-{int(datetime.datetime.now().timestamp()) % 10000}")
                name = body.get('name', '').strip()
                category = body.get('category', 'Makanan & Camilan')
                unit = body.get('unit', 'Pcs')
                price = int(body.get('price', 0))
                old_price = int(body.get('old_price', 0)) if body.get('old_price') else None
                stock = int(body.get('stock', 0))
                description = body.get('description', '')
                images = body.get('images', [])
                if not images:
                    images = ['https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=600&q=80']
                images_json = json.dumps(images)
                is_discount = 1 if old_price and old_price > price else 0
                is_featured = 1 if body.get('is_featured') else 0
                is_free_shipping = 1 if body.get('is_free_shipping') else 0

                if prod_id:
                    # Update
                    c.execute("""
                        UPDATE products SET sku=?, name=?, category=?, unit=?, price=?, old_price=?, stock=?, description=?, images_json=?, is_discount=?, is_featured=?, is_free_shipping=?
                        WHERE id=?
                    """, (sku, name, category, unit, price, old_price, stock, description, images_json, is_discount, is_featured, is_free_shipping, prod_id))
                    act = 'PRODUCT_UPDATED'
                else:
                    # Create
                    prod_id = f"prod-{store_id.split('-')[-1]}-{int(datetime.datetime.now().timestamp()) % 10000}"
                    c.execute("""
                        INSERT INTO products (id, store_id, sku, name, category, unit, price, old_price, stock, sold_count, description, images_json, is_discount, is_featured, is_free_shipping, is_active)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)
                    """, (prod_id, store_id, sku, name, category, unit, price, old_price, stock, description, images_json, is_discount, is_featured, is_free_shipping))
                    act = 'PRODUCT_CREATED'

                c.execute("""
                    INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                    VALUES (?, ?, 'PRODUCT', ?, ?, ?, ?, ?)
                """, (f"aud-{datetime.datetime.now().timestamp()}", act, prod_id, admin_id, admin_name, f"Perubahan produk {name} - Stok: {stock}, Harga: Rp {price:,}", now))

                conn.commit()
                self._send_json({"success": True, "id": prod_id})
                return

            # 10. Update Tier Settings (Admin Toko / Pusat)
            if path == '/api/tier-settings':
                admin_id = body.get('admin_id')
                silver_min = int(body.get('silver_min', 0))
                gold_min = int(body.get('gold_min', 500000))
                platinum_min = int(body.get('platinum_min', 1500000))
                eval_months = int(body.get('evaluation_months', 12))

                c.execute("""
                    UPDATE tier_settings SET silver_min = ?, gold_min = ?, platinum_min = ?, evaluation_months = ?, updated_at = ?
                    WHERE id = 'tier-global'
                """, (silver_min, gold_min, platinum_min, eval_months, now))

                conn.commit()
                self._send_json({"success": True})
                return

            # 11. Upload Product Photo to System Folder
            if path == '/api/upload':
                files_data = body.get('files', [])
                if not files_data and body.get('data'):
                    files_data = [{'filename': body.get('filename', 'photo.jpg'), 'data': body.get('data')}]

                uploads_dir = os.path.join(PUBLIC_DIR, "uploads")
                os.makedirs(uploads_dir, exist_ok=True)

                saved_urls = []
                for f in files_data:
                    raw_b64 = f.get('data', '')
                    if ',' in raw_b64:
                        raw_b64 = raw_b64.split(',', 1)[1]
                    try:
                        img_bytes = base64.b64decode(raw_b64)
                        orig_name = f.get('filename', 'photo.jpg')
                        ext = '.jpg'
                        if '.' in orig_name:
                            ext = '.' + orig_name.rsplit('.', 1)[1].lower()
                            if ext not in ['.jpg', '.jpeg', '.png', '.webp']:
                                ext = '.jpg'
                        filename = f"prod_{int(datetime.datetime.now().timestamp()*1000)}_{len(saved_urls)}{ext}"
                        filepath = os.path.join(uploads_dir, filename)
                        with open(filepath, 'wb') as out_f:
                            out_f.write(img_bytes)
                        saved_urls.append(f"/uploads/{filename}")
                    except Exception as err:
                        print("Error saving upload:", err)

                self._send_json({"success": True, "urls": saved_urls, "url": saved_urls[0] if saved_urls else ""})
                return

            # 12. Authentication Login
            if path == '/api/auth/login':
                user_id = body.get('user_id')
                phone = body.get('phone', '').strip()
                role = body.get('role', 'consumer')
                name = body.get('name', '').strip()

                if user_id:
                    user = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                elif phone:
                    user = c.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
                    if not user:
                        # Auto register consumer if phone not found
                        user_id = f"usr-{int(datetime.datetime.now().timestamp())}"
                        c.execute("""
                            INSERT INTO users (id, name, email, phone, role, store_id, tier, points, wallet_balance, created_at)
                            VALUES (?, ?, '', ?, ?, NULL, 'Silver', 0, 50000, ?)
                        """, (user_id, name or f"Konsumen {phone[-4:] if len(phone)>=4 else phone}", phone, role, now))
                        c.execute("""
                            INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
                            VALUES (?, ?, 'credit_topup', 50000, 50000, 'WELCOME', 'System', 'Bonus saldo awal registrasi', ?)
                        """, (f"wled-{datetime.datetime.now().timestamp()}", user_id, now))
                        conn.commit()
                        user = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                else:
                    user = c.execute("SELECT * FROM users WHERE role = ? LIMIT 1", (role,)).fetchone()

                if not user:
                    self._send_json({"error": "Pengguna tidak ditemukan"}, 404)
                    return

                d_user = dict(user)
                addresses = [dict(r) for r in c.execute("SELECT * FROM addresses WHERE user_id = ?", (d_user['id'],)).fetchall()]
                d_user['addresses'] = addresses
                self._send_json({"success": True, "user": d_user})
                return

            # 13. Authentication Register
            if path == '/api/auth/register':
                name = body.get('name', '').strip()
                phone = body.get('phone', '').strip()
                email = body.get('email', '').strip()
                if not name or not phone:
                    self._send_json({"error": "Nama dan Nomor Telepon wajib diisi"}, 400)
                    return
                existing = c.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
                if existing:
                    self._send_json({"error": "Nomor telepon sudah terdaftar, silakan langsung login"}, 400)
                    return
                user_id = f"usr-{int(datetime.datetime.now().timestamp())}"
                c.execute("""
                    INSERT INTO users (id, name, email, phone, role, store_id, tier, points, wallet_balance, created_at)
                    VALUES (?, ?, ?, ?, 'consumer', NULL, 'Silver', 0, 50000, ?)
                """, (user_id, name, email, phone, now))
                c.execute("""
                    INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference_id, actor, note, created_at)
                    VALUES (?, ?, 'credit_topup', 50000, 50000, 'WELCOME', 'System', 'Bonus saldo pendaftaran pengguna baru', ?)
                """, (f"wled-{datetime.datetime.now().timestamp()}", user_id, now))
                conn.commit()
                user = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                d_user = dict(user)
                d_user['addresses'] = []
                self._send_json({"success": True, "user": d_user})
                return

            # 14. Central Admin Store CRUD (Create, Update, Delete, Toggle Active)
            if path == '/api/central/stores':
                action = body.get('action') # 'create', 'update', 'toggle_active', 'delete'
                admin_id = body.get('admin_id', 'usr-admin-pusat')
                admin = c.execute("SELECT name FROM users WHERE id = ?", (admin_id,)).fetchone()
                admin_name = admin['name'] if admin else 'Admin Pusat'

                store_id = body.get('id')
                if action == 'toggle_active':
                    st = c.execute("SELECT is_active, name FROM stores WHERE id = ?", (store_id,)).fetchone()
                    if not st:
                        self._send_json({"error": "Toko tidak ditemukan"}, 404)
                        return
                    new_status = 0 if st['is_active'] == 1 else 1
                    c.execute("UPDATE stores SET is_active = ? WHERE id = ?", (new_status, store_id))
                    c.execute("""
                        INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                        VALUES (?, ?, 'STORE', ?, ?, ?, ?, ?)
                    """, (f"aud-{datetime.datetime.now().timestamp()}", "STORE_STATUS_TOGGLED", store_id, admin_id, admin_name, f"Status toko {st['name']} diubah menjadi {'Aktif' if new_status else 'Nonaktif'}", now))
                    conn.commit()
                    self._send_json({"success": True, "is_active": new_status, "store_id": store_id})
                    return

                elif action == 'delete':
                    st = c.execute("SELECT name FROM stores WHERE id = ?", (store_id,)).fetchone()
                    c.execute("DELETE FROM stores WHERE id = ?", (store_id,))
                    c.execute("""
                        INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                        VALUES (?, 'STORE_DELETED', 'STORE', ?, ?, ?, ?, ?)
                    """, (f"aud-{datetime.datetime.now().timestamp()}", store_id, admin_id, admin_name, f"Toko {st['name'] if st else store_id} dihapus dari jaringan", now))
                    conn.commit()
                    self._send_json({"success": True})
                    return

                elif action in ('create', 'update'):
                    name = body.get('name', '').strip()
                    address = body.get('address', '').strip()
                    lat = float(body.get('lat', -6.2))
                    lng = float(body.get('lng', 106.8))
                    phone = body.get('phone', '')
                    operating_hours = body.get('operating_hours', '07:00 - 22:00')
                    delivery_radius_km = float(body.get('delivery_radius_km', 15.0))
                    base_fare = int(body.get('base_fare', 8000))
                    per_km_fare = int(body.get('per_km_fare', 2500))
                    is_active = int(body.get('is_active', 1))

                    if not name or not address:
                        self._send_json({"error": "Nama dan alamat toko wajib diisi"}, 400)
                        return

                    if action == 'create':
                        store_id = body.get('id') or f"store-{int(datetime.datetime.now().timestamp()) % 10000}"
                        c.execute("""
                            INSERT INTO stores (id, name, address, lat, lng, phone, operating_hours, delivery_radius_km, base_fare, per_km_fare, is_active)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (store_id, name, address, lat, lng, phone, operating_hours, delivery_radius_km, base_fare, per_km_fare, is_active))
                        act = 'STORE_CREATED'
                    else:
                        c.execute("""
                            UPDATE stores SET name=?, address=?, lat=?, lng=?, phone=?, operating_hours=?, delivery_radius_km=?, base_fare=?, per_km_fare=?, is_active=?
                            WHERE id=?
                        """, (name, address, lat, lng, phone, operating_hours, delivery_radius_km, base_fare, per_km_fare, is_active, store_id))
                        act = 'STORE_UPDATED'

                    c.execute("""
                        INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, actor_name, details, created_at)
                        VALUES (?, ?, 'STORE', ?, ?, ?, ?, ?)
                    """, (f"aud-{datetime.datetime.now().timestamp()}", act, store_id, admin_id, admin_name, f"Kelola toko {name} ({address})", now))
                    conn.commit()
                    self._send_json({"success": True, "store_id": store_id})
                    return

            self._send_json({"error": "POST route not found"}, 404)
        except Exception as e:
            self._send_json({"error": str(e)}, 500)
        finally:
            conn.close()


def run():
    init_db()
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, CSMartHandler)
    print(f"CS Mart Delivery HTTP Server running on http://127.0.0.1:{PORT}")

    # Optional HTTPS Server for PWA testing across local network
    cert_file = os.path.join(BASE_DIR, 'cert.pem')
    key_file = os.path.join(BASE_DIR, 'key.pem')
    if os.path.exists(cert_file) and os.path.exists(key_file):
        try:
            https_address = ('', 8443)
            httpsd = ThreadingHTTPServer(https_address, CSMartHandler)
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
            httpsd.socket = ssl_ctx.wrap_socket(httpsd.socket, server_side=True)
            print(f"CS Mart Delivery HTTPS Server running on https://127.0.0.1:8443")
            t = threading.Thread(target=httpsd.serve_forever, daemon=True)
            t.start()
        except Exception as e:
            print("Could not start HTTPS listener:", e)

    # Start Cloudflare Tunnel for 1-Click Native PWA Install
    start_cloudflared_tunnel()

    httpd.serve_forever()

if __name__ == '__main__':
    run()
