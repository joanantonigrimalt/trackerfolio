# DB Proxy Setup

Este es un servidor proxy que permite a Vercel conectarse a la base de datos MySQL a través de HTTP.

## Instalación en el servidor 188.245.81.1

### Opción 1: Usando cPanel/Plesk

1. **Sube el archivo `db-proxy.js`** a `/home/joantoni/public_html/` o `/home/joantoni/db-proxy/`

2. **Instala dependencias:**
```bash
cd /home/joantoni/db-proxy
npm install express mysql2 cors
```

3. **Crea un script de inicio** (`.sh`):
```bash
#!/bin/bash
cd /home/joantoni/db-proxy
NODE_ENV=production \
MYSQL_HOST=localhost \
MYSQL_USER=joanT \
MYSQL_PASSWORD=@@JTONY22@@ \
MYSQL_DATABASE=joantoni \
DB_PROXY_PORT=3000 \
DB_PROXY_TOKEN=finasset-proxy-secret-key \
node db-proxy.js > db-proxy.log 2>&1 &
```

4. **Configura un reverse proxy en cPanel**:
   - Ve a cPanel → Domains → Addon Domains
   - Crea un dominio/subdominio: `db-proxy.finasset.app`
   - Apunta a `/home/joantoni/db-proxy`
   - En `.htaccess`, redirige todo a Node.js:
   ```
   <IfModule mod_rewrite.c>
     RewriteEngine On
     RewriteRule ^(.*)$ http://127.0.0.1:3000/$1 [P,L]
   </IfModule>
   ```

### Opción 2: Usando PM2 (recomendado)

```bash
npm install -g pm2
pm2 start db-proxy.js --name "db-proxy" \
  --env "MYSQL_HOST=localhost" \
  --env "MYSQL_USER=joanT" \
  --env "MYSQL_PASSWORD=@@JTONY22@@" \
  --env "MYSQL_DATABASE=joantoni" \
  --env "DB_PROXY_PORT=3000" \
  --env "DB_PROXY_TOKEN=finasset-proxy-secret-key"
pm2 save
```

### Opción 3: Usando Forever

```bash
npm install -g forever
forever start db-proxy.js
```

## Verificar que funciona

```bash
curl http://localhost:3000/health
```

Debería devolver:
```json
{"status":"ok","message":"Database connected"}
```

## Configurar en Vercel

Las variables de entorno para Vercel:

```
DB_PROXY_URL=https://db-proxy.finasset.app
DB_PROXY_TOKEN=finasset-proxy-secret-key
```

El backend de Vercel usará esto para conectarse a la BD.

## Seguridad

⚠️ **IMPORTANTE**: Cambiar `DB_PROXY_TOKEN` a un valor seguro en producción.

El proxy solo permite:
- SELECT queries en `/query`
- INSERT/UPDATE/DELETE en `/exec` (requiere token)
- Endpoints específicos sin token
