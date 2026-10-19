# SSH bastion for tunnel tests. User "tunnel" / password "tunnel", plus the throwaway
# test key in this folder (never use it anywhere else).
FROM alpine:3.22

RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tunnel \
 && echo 'tunnel:tunnel' | chpasswd \
 && mkdir -p /home/tunnel/.ssh \
 && sed -i -e 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' \
           -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' \
           -e 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY test_key.pub /home/tunnel/.ssh/authorized_keys
RUN chown -R tunnel:tunnel /home/tunnel/.ssh && chmod 700 /home/tunnel/.ssh && chmod 600 /home/tunnel/.ssh/authorized_keys

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
