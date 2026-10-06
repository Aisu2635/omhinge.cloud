---
title: Moving 100+ services from Nginx Ingress to Traefik with zero downtime
date: 2026-04-28
summary: Why I replaced ingress-nginx with Traefik across two organisations, what got simpler, and what didn't carry over.
tags: [kubernetes, traefik, ingress, aks]
cover: /assets/blog/nginx-to-traefik/cover.png
linkedin: https://www.linkedin.com/posts/om-hinge2635_recently-worked-on-migrating-a-kubernetes-share-7454901793039216640--JGw/
---

I recently migrated our Kubernetes ingress layer from Nginx to Traefik: 100+ microservices across two organisations, BFHL and Vidal Health. I handled it end to end on my own, and we finished with zero downtime, just a controlled, gradual transition.

This is the longer version of what I learned.

## Why move at all

The decision was about long-term sustainability. Nginx Ingress is no longer actively maintained, and ingress is not a layer where you want to be running unmaintained software. Every request into the clusters goes through it.

So the question wasn't whether to move, but what to move to, and to do it before end-of-life forced our hand.

## Why Traefik

After evaluating the options, Traefik stood out for three reasons:

- **Kubernetes-native design.** Routing is described with CRDs, so ingress config is ordinary Kubernetes objects that you can review, diff and version like everything else.
- **A cleaner configuration model.** Behaviour lives in reusable **Middleware** objects instead of long lists of annotations copied onto every Ingress.
- **Built-in observability.** Per-route and per-service metrics come out of the box.

![Before: annotations repeated on every Ingress. After: shared Middleware and metrics per route.](/assets/blog/nginx-to-traefik/diagram.png)

## What got simpler

### Less configuration, less copy-paste

With Nginx, the same behaviour (rate limits, headers, redirects, auth) tends to be repeated as annotations on many Ingress objects. With Traefik I consolidated those into Middleware that routes reference by name. A change that used to touch dozens of manifests now touches one.

A simplified example of the shape of that change:

```yaml before: ingress-nginx annotations on every Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/limit-rps: "50"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Frame-Options: DENY";
```

```yaml after: one Middleware, referenced by many routes
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: secure-defaults
spec:
  headers:
    frameDeny: true
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: orders-api
spec:
  entryPoints: [websecure]
  routes:
    - match: Host(`api.example.com`) && PathPrefix(`/orders`)
      kind: Rule
      middlewares:
        - name: secure-defaults
        - name: rate-limit
      services:
        - name: orders-api
          port: 80
```

### Fewer reload-style disruptions

Traefik picks up configuration changes dynamically. In practice that meant fewer reload-style blips and more predictable behaviour when routes changed.

## Observability at the ingress layer

This is where Traefik clearly stood out. It exposes per-route and per-service metrics without any extra setup, so traffic patterns, error rates and latency are visible right away.

With Nginx, getting the same level of visibility usually means extra configuration or external tooling. With Traefik it's just there. Having that granularity made debugging easier, made monitoring sharper, and gave me much more confidence during deployments, including the migration itself.

## What didn't carry over

There was a lot of learning along the way, especially around differences in behaviour and configuration patterns. Some assumptions from Nginx don't map one-to-one onto Traefik.

The biggest lesson was to **rethink each implementation instead of replicating it.** Translating annotations line by line would have carried old workarounds into the new setup. Asking "what is this annotation actually for?" usually led to a simpler Traefik equivalent, and sometimes to deleting it.

## Takeaways

- Treat ingress as critical infrastructure: don't wait for end-of-life to plan the move.
- Use the migration to clean up. Consolidate repeated behaviour into reusable pieces.
- Make observability part of the target, not an afterthought. It's what lets you migrate gradually and safely.
- In the end this wasn't just a tool replacement. It was a step towards a more maintainable and scalable ingress setup.
