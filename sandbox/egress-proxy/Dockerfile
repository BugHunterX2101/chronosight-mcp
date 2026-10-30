# Egress proxy image (DESIGN §19). Node 24 runs proxy.ts directly (type stripping).
FROM node:24-alpine
COPY proxy.ts /app/proxy.ts
USER node
EXPOSE 3128
CMD ["node", "/app/proxy.ts"]
