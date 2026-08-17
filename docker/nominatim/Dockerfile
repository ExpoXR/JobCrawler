# syntax=docker/dockerfile:1
FROM mediagis/nominatim@sha256:7923a8e67197fc6d4f4ecb7c0e8bbedffeddcfdf4519596fe946e46a28f5a9f8

# The upstream runtime includes unused kernel development headers. They carry
# no runtime value and unnecessarily expand the vulnerability surface.
RUN apt-get purge -y linux-libc-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i '1s|bash -ex|bash -e|' /app/config.sh /app/init.sh /app/start.sh \
  && sed -i 's|useradd -m -p ${NOMINATIM_PASSWORD} nominatim|useradd -m -s /usr/sbin/nologin nominatim|' /app/start.sh \
  && sed -i "s|^SCP=.*$|SCP='false'|" /app/init.sh
