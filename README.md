# C++ Game Studio (iPad手順)
Frontend = Vercel / Backend+emscripten+raylib = Railway (compiler/Dockerfile)

## 1. GitHubへ置く
1. github.com で New repository → `cpp-game-studio` を作成。
2. このZIPを iPad の「ファイル」で展開。
3. リポジトリ画面 → Code → Codespaces → Create (ブラウザ内VS Code+ターミナル)。
4. Codespaces 左のエクスプローラーに展開したフォルダ内容をドラッグ、またはZIPをアップロードして `unzip -o cpp-game-studio.zip`。
5. ターミナル: `git add -A && git commit -m init && git push`

## 2. Railway (バックエンド)
1. railway.app → New Project → Deploy from GitHub → このリポジトリ。ルートディレクトリはリポジトリ直下 (railway.json が Dockerfile を指定)。
2. Variables: `API_KEY`(長いランダム文字列), `CORS_ORIGIN`(VercelのURL) を設定 (.env.example参照)。
3. Settings → Networking → Generate Domain。`https://xxx.up.railway.app/health` が {"ok":true} なら成功。
4. Volume を /data にマウントするとサーバー保存が永続化。初回ビルドは raylib のコンパイルで10分程度かかります。メモリは2GB以上推奨。

## 3. Vercel (フロント)
1. vercel.com → Add New Project → リポジトリ選択 → **Root Directory = frontend**。
2. Environment Variable `VITE_API_URL` = RailwayのURL → Deploy。

## 4. 使い方
VercelのURLをSafariで開く → ⚙ SettingsでバックエンドURLとAPI_KEYを入力 → 🔨 Build & Run。
ホーム画面に追加(共有→ホーム画面に追加)でアプリのように使えます。
