# Staging Deployment Guide

This guide walks you through deploying the Stock Management System to staging.

## Prerequisites

1. **MongoDB Atlas** - Staging cluster running (see [MongoDB Atlas Setup](MONGODB_ATLAS_SETUP.md))
2. **Docker** - Installed on server
3. **Nginx** - Installed on server
4. **Domain** - Pointing to staging server (e.g., `staging.yourdomain.com`)

---

## Step 1: Prepare the Server

```bash
# SSH into your staging server
ssh user@staging-server

# Create application directory
sudo mkdir -p /var/www/stock-management
cd /var/www/stock-management

# Clone your repository
sudo git clone https://github.com/yourusername/stock-management.git .
```

---

## Step 2: Configure Environment

```bash
# Copy the example env file
sudo cp .env.staging.example .env.staging

# Edit with your staging values
sudo nano .env.staging
```

Required changes:
- `MONGODB_URI` - Your staging Atlas connection string
- `JWT_SECRET` - Generate a strong key: `openssl rand -hex 32`
- `FRONTEND_URL` - Your staging frontend URL

The backend derives its CORS origin from `FRONTEND_URL` (scheme and host); set it to the origin users open in their browser. Add any additional trusted browser origins to `CORS_ORIGINS` and redeploy the backend after changing these values.

---

## Step 3: Build Docker Image

```bash
# Build the image
docker build -t stock-management:staging .
```

---

## Step 4: Configure Nginx

```bash
# Copy staging nginx config
sudo cp nginx/staging.conf /etc/nginx/sites-available/stock-staging

# Enable the site
sudo ln -s /etc/nginx/sites-available/stock-staging /etc/nginx/sites-enabled/

# Test nginx config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

---

## Step 5: Run with Docker Compose

```bash
# Start the staging environment
docker-compose -f docker-compose.yml -f docker-compose.staging.yml up -d

# View logs
docker-compose -f docker-compose.yml -f docker-compose.staging.yml logs -f app

# Check status
docker-compose -f docker-compose.yml -f docker-compose.staging.yml ps
```

---

## Step 6: Verify Deployment

```bash
# Test health endpoint
curl http://localhost:3000/health

# Test API health
curl http://localhost:3000/api/health

# Check logs
docker logs stock-management-staging
```

---

## Step 7: Test External Access

1. Access `http://staging.yourdomain.com/health`
2. Access `http://staging.yourdomain.com/api/health`
3. Try logging in at `http://staging.yourdomain.com/api/auth/login`

---

## Quick Commands

| Command | Description |
|---------|-------------|
| `docker-compose up -d` | Start staging |
| `docker-compose down` | Stop staging |
| `docker-compose logs -f` | View logs |
| `docker-compose restart` | Restart services |
| `./scripts/healthcheck.sh` | Run health check |

---

## Troubleshooting

### "Connection refused" to MongoDB
- Check `MONGODB_URI` in `.env.staging`
- Verify Atlas network access allows your server IP

### 502 Bad Gateway
- Check if Docker containers are running: `docker ps`
- Check container logs: `docker logs stock-management-staging`
- Verify nginx is proxying correctly

### SSL Certificate Issues
- Use Let's Encrypt: `sudo certbot --nginx -d staging.yourdomain.com`
- Or manually install certificates and uncomment SSL section in staging.conf

---

## Next Steps

1. **Configure SSL** (9.7) - Add HTTPS to staging
2. **Set up CI/CD** (9.3) - Automate deployments
3. **Enable monitoring** (9.8-9.10) - Add logging & error tracking