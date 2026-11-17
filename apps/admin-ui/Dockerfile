FROM nginx:1.27-alpine

# Substitute only application settings. Preserve Nginx variables such as
# $host, $uri, $remote_addr and $proxy_add_x_forwarded_for in the template.
ENV NGINX_ENVSUBST_FILTER="^ADMIN_UI_API_(HOST|PORT)$"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
COPY app.js /usr/share/nginx/html/app.js
COPY styles.css /usr/share/nginx/html/styles.css
RUN mkdir -p /var/www/certbot /etc/nginx/tls
