# Verified Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev --audit-level=high
docker compose config --quiet
docker compose -f docker-compose.nominatim.yml config --quiet
docker compose build web worker migrate
docker compose -f docker-compose.nominatim.yml up -d
docker exec expojobcrawler-nominatim curl -fsS http://127.0.0.1:8080/status
E2E_BASE_URL=http://127.0.0.1:3005 npm run test:e2e
midclt call pool.snapshottask.run 6
midclt call -j -jp description replication.run 2
zfs list -t snapshot -o name,creation,used -s creation
```
