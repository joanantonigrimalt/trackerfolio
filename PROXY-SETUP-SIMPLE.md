# Setup Proxy - Forma Fácil (PHP)

## Paso 1: Sube el archivo a tu servidor via cPanel

1. Ve a **cPanel → File Manager**
2. Navega a `/home/joantoni/public_html`
3. Crea una carpeta llamada `db-proxy`
4. Sube el archivo **`db-proxy.php`** dentro de esa carpeta, renómbralo a `index.php`

## Paso 2: Accede al proxy

```
https://finasset.app/db-proxy/health
```

Debería devolver:
```json
{"status":"ok","message":"Database connected"}
```

## Paso 3: Configura en Vercel

Ve a: https://vercel.com/grigoms-projects/finasset-site/settings/environment-variables

Agrega/Actualiza:
- `DB_PROXY_URL` = `https://finasset.app/db-proxy`
- `DB_PROXY_TOKEN` = `finasset-proxy-secret`

## Paso 4: Deploy en Vercel

```bash
vercel deploy --prod
```

---

## ¿Cómo funciona?

- Tu servidor (188.245.81.1) tiene MySQL local
- El archivo `db-proxy.php` lo expone vía HTTP
- Vercel puede acceder a `https://finasset.app/db-proxy`
- Login y datos del usuario funcionarán automáticamente

## Endpoints disponibles

### Health Check
```
GET https://finasset.app/db-proxy/health
```

### Ejecutar SELECT
```
POST https://finasset.app/db-proxy/query
Body: {"sql": "SELECT * FROM users", "params": []}
```

### Ejecutar INSERT/UPDATE/DELETE
```
POST https://finasset.app/db-proxy/exec
Headers: {"X-DB-Token": "finasset-proxy-secret"}
Body: {"sql": "INSERT INTO users ...", "params": []}
```
