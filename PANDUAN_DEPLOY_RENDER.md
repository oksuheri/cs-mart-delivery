# Panduan Lengkap Deploy CS Mart Delivery ke Render.com (Gratis)

Panduan ini disiapkan agar aplikasi **CS Mart Delivery** dapat diakses secara publik melalui domain HTTPS resmi, dengan database SQLite aktif, serta mendukung **fitur popup instalasi 1-klik PWA di HP Android/iOS**.

---

## Ringkasan Konfigurasi yang Sudah Disiapkan

Di dalam folder proyek ini telah dibuatkan file khusus untuk Render:
1. **`render.yaml`**: Konfigurasi otomatis (*Blueprint*) untuk Render.
2. **`Dockerfile`**: Opsi container jika Anda ingin deploy via Docker.
3. **`requirements.txt`**: Spesifikasi dependensi Python.
4. **`server.py`**: Sudah disesuaikan untuk membaca `$PORT` dinamis dari Render dan variabel `RENDER_EXTERNAL_URL`.
5. **`.gitignore` & `.dockerignore`**: Memastikan binary lokal (`cloudflared`) dan file sementara tidak terupload ke cloud.

---

## Langkah 1: Unggah Proyek ke GitHub

1. Buka terminal di folder proyek ini (atau gunakan terminal IDE).
2. Jika belum diinisialisasi git, jalankan perintah berikut:
   ```bash
   git init
   git add .
   git commit -m "Siap deploy ke Render.com"
   ```
3. Buka [GitHub.com](https://github.com/) dan buat repositori baru (misalnya diberi nama `cs-mart-delivery`, bisa diset **Public** atau **Private**).
4. Hubungkan dan upload kode Anda ke GitHub:
   ```bash
   git branch -M main
   git remote add origin https://github.com/USERNAME-ANDA/cs-mart-delivery.git
   git push -u origin main
   ```

---

## Langkah 2: Deploy di Render.com (1-Klik)

1. Buka **[dashboard.render.com](https://dashboard.render.com/)** dan Login/Daftar (disarankan klik *Sign in with GitHub* agar otomatis terhubung).
2. Di dashboard Render, klik tombol **"New +"** di kanan atas > pilih **"Web Service"**.
3. Pilih opsi **"Build and deploy from a Git repository"** lalu klik **Next**.
4. Cari dan pilih repositori `cs-mart-delivery` yang baru saja Anda upload di GitHub.
5. Lengkapi formulir pengaturan (sangat mudah):
   * **Name**: `cs-mart-delivery` *(atau nama yang Anda inginkan)*
   * **Region**: `Singapore` *(paling cepat diakses dari Indonesia)*
   * **Branch**: `main`
   * **Runtime**: `Python 3`
   * **Build Command**: `pip install -r requirements.txt || true`
   * **Start Command**: `python server.py`
   * **Instance Type**: Pilih **Free** ($0 / bulan)
6. Scroll ke bawah dan klik tombol **"Create Web Service"**.

---

## Langkah 3: Ujicoba Real di HP

1. Tunggu proses build selesai sekitar 1–2 menit sampai status berubah menjadi **Live** (berwarna hijau).
2. Render akan memberikan alamat domain HTTPS resmi publik gratis Anda, contoh:
   ```text
   https://cs-mart-delivery.onrender.com
   ```
3. Buka alamat tersebut di Google Chrome HP Anda:
   * **Katalog Produk**: Semua 10 produk langsung tampil lengkap.
   * **Popup 1-Klik Otomatis**: Ketuk tombol **"⚡ Pasang Sekarang"**, dialog bawaan sistem Android (*"Pasang aplikasi CS Mart? [Batal] [Pasang]"*) akan **langsung muncul di layar HP** tanpa perlu membuka menu titik tiga.
   * **Login & Belanja**: Anda bisa langsung mencoba login konsumen/admin toko/kurir dan mencoba belanja secara online nyata.
