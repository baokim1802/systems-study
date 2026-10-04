# How the Internet Works

> When you load a web page, your data is chopped into thousands of small envelopes that hop across a dozen machines owned by different companies, and they all arrive. Knowing how that works is the base for everything else in networking and system design.

## The big idea

Imagine mailing a 300-page book to a friend in another country, but the post office only accepts **postcards**. You'd:

1. Split the book into numbered postcards.
2. Write your friend's **address** and your return address on each.
3. Drop them in the mailbox. Each sorting center looks at the address, decides "next stop: that sorting center", and passes it on. No sorting center knows the whole route.
4. Your friend collects the postcards and reassembles the book by number.

That's the internet. The postcards are **packets**, the addresses are **IP addresses**, the sorting centers are **routers**, and "number the postcards and resend lost ones" is **TCP** (tomorrow's topic). The internet is literally a network of networks: tens of thousands of independent networks (your ISP, Google, a university) that agree to pass each other's packets.

## Packets

A **packet** is a small chunk of data with a header in front. A typical maximum size on Ethernet and most of the internet is **1,500 bytes** (called the **MTU**, maximum transmission unit). A 3 MB web page therefore travels as roughly `3,000,000 / 1,460 ≈ 2,055` packets (about 40 bytes of each go to IP and TCP headers).

Why chop things up instead of opening a dedicated wire, like old phone calls did (**circuit switching**)? Because with **packet switching**:

- Many conversations share the same links; idle time isn't wasted.
- If a link breaks, routers just send the next packets another way.
- One huge download can't hog a link: its packets interleave with everyone else's.

## IP addresses

An **IP address** identifies a network interface on the internet, the way a street address identifies a house.

**IPv4** addresses are 32 bits, written as four bytes in decimal: `142.250.74.46`. Each part is 0–255 (one byte, Day 2).

```text
2^32 = 4,294,967,296 ≈ 4.3 billion addresses
```

That sounded like plenty in 1981. Today there are many more devices than that, and the regional registries ran out of fresh IPv4 blocks in the 2010s. Two fixes: NAT (below) and IPv6.

**IPv6** addresses are 128 bits, written as eight groups of hex: `2001:0db8:0000:0000:0000:ff00:0042:8329`, shortened to `2001:db8::ff00:42:8329` (leading zeros dropped, one run of zero-groups replaced by `::`).

```text
2^128 ≈ 3.4 × 10^38 addresses   (enough to give every grain of sand on Earth billions of billions)
```

### Networks and CIDR

Addresses are handed out in blocks. **CIDR notation** `203.0.113.0/24` means "the first 24 bits are the network part, the rest identify hosts inside it". So a `/24` has `32 − 24 = 8` host bits → `2^8 = 256` addresses. A `/16` has `2^16 = 65,536`. Routers route by the network prefix, which is why the global routing table has about a million entries instead of 4 billion.

```js
// How many addresses in a CIDR block?
const size = prefix => 2 ** (32 - prefix);
console.log(size(24), size(16), size(8)); // 256 65536 16777216
```

## Routers: one hop at a time

A **router** is a computer with several network connections whose job is forwarding packets. For each packet it looks at the destination IP, finds the most specific matching prefix in its **routing table**, and sends it out the corresponding link. That's it: **no router knows the full path**, only the best next hop.

```text
 Your laptop ─> home router ─> ISP ─> ISP backbone ─> internet exchange ─> Google's network ─> server
   10.0.0.12     (NAT)         hop 3     hops 4-7          hop 8               hops 9-12
```

You can see the hops yourself with `traceroute google.com` (macOS/Linux) or `tracert google.com` (Windows). A typical path is 10–20 hops.

How do routers learn routes between companies? The **Border Gateway Protocol (BGP)**: each network (an **Autonomous System**, e.g. AS15169 is Google) announces "I can reach these prefixes". It's built on trust, which is why a misconfigured BGP announcement can take big chunks of the internet offline (Facebook's 2021 outage started with routes being withdrawn).

Each IP packet also carries a **TTL (time to live)** counter, decremented at every hop; at 0 the packet is dropped. That stops packets from looping forever if routes are misconfigured, and it's exactly the trick `traceroute` uses (send packets with TTL 1, 2, 3, … and see who complains).

## Layers: who does what

Networking is built in **layers**. Each layer does one job and relies on the layer below, like the parts of a letter: the letter (your content), the envelope (addressing), the truck (physical transport).

| TCP/IP layer | OSI layers | Job | Examples | Address it uses |
|---|---|---|---|---|
| Application | 7 (5, 6) | What the data *means* | HTTP, DNS, SMTP, SSH | URLs, hostnames |
| Transport | 4 | Which program; reliability | TCP, UDP | **Port** numbers |
| Internet | 3 | Which machine, across networks | IP, ICMP | **IP** addresses |
| Link | 2 (1) | Next device on the same local network | Ethernet, Wi-Fi | **MAC** addresses |

The **OSI model** has 7 layers (physical, data link, network, transport, session, presentation, application); the practical **TCP/IP model** squashes it to 4. Interviewers say "layer 4" (transport) and "layer 7" (application) all the time, for example "an L4 load balancer" vs "an L7 load balancer" (Day 28).

**Encapsulation** is how layers stack: each layer wraps the one above in its own header.

```text
                                   [ HTTP request: GET /index.html ... ]   application
                      [ TCP hdr | HTTP request ............................ ]   transport  (ports)
            [ IP hdr | TCP hdr | HTTP request ............................ ]   internet   (IPs)
 [ Eth hdr | IP hdr | TCP hdr | HTTP request ............................ | Eth trailer ]   link (MACs)
```

At each router, the link-layer envelope is replaced (new MACs for the next hop), but the IP header's source and destination stay the same end to end (except through NAT).

## Ports: which program?

An IP address gets the packet to the machine. A **port** (a 16-bit number, 0–65535) gets it to the right program. Think of the IP as the apartment building and the port as the apartment number.

| Port | Service |
|---|---|
| 22 | SSH |
| 53 | DNS |
| 80 | HTTP |
| 443 | HTTPS |
| 5432 | PostgreSQL |
| 6379 | Redis |

A connection is identified by the **5-tuple**: protocol, source IP, source port, destination IP, destination port. Your browser picks a random **ephemeral port** (e.g. 52814) as the source, so two tabs talking to the same server are still distinct connections.

```js
// A tiny server listening on port 3000. Run with node and visit http://localhost:3000
require("http").createServer((req, res) => {
  res.end(`Hello from port 3000! You came from ${req.socket.remoteAddress}:${req.socket.remotePort}\n`);
}).listen(3000);
```

## Private IPs and NAT

Some ranges are reserved as **private**: they're used inside homes and offices and never routed on the public internet.

```text
10.0.0.0/8        (16.7 million addresses)
172.16.0.0/12     (1 million)
192.168.0.0/16    (65,536)       ← your home Wi-Fi is almost certainly here
127.0.0.0/8       loopback: "this machine" (127.0.0.1 = localhost)
```

So your laptop is `192.168.1.23`, your phone `192.168.1.24`, and so are millions of other laptops in other homes. How do they reach the internet? **NAT (Network Address Translation)**: your home router has one public IP from your ISP and rewrites packets as they leave:

```text
 Laptop 192.168.1.23:52814  ──>  Router rewrites  ──>  85.12.4.7:40001  ──> server
 Phone  192.168.1.24:52814  ──>  Router rewrites  ──>  85.12.4.7:40002  ──> server

 Router's NAT table:
   85.12.4.7:40001  <->  192.168.1.23:52814
   85.12.4.7:40002  <->  192.168.1.24:52814
```

When a reply comes back to port 40001, the router looks it up and forwards it to the laptop. Consequences worth knowing:

- One public IP can hide a whole household (or, with carrier-grade NAT, thousands of customers).
- Devices behind NAT can make outgoing connections easily but **can't easily accept incoming ones**: nobody outside knows `192.168.1.23`. That's why peer-to-peer apps and video calls need tricks (STUN/TURN servers) and why your laptop can't host a public website without port forwarding.
- In the cloud, your servers usually have private IPs inside a **VPC** (virtual private cloud), and only load balancers or NAT gateways have public ones. That's a security feature.

## The math: how long does a packet take?

Latency has four parts: **propagation** (distance ÷ signal speed), **transmission** (packet size ÷ link bandwidth), **queuing** (waiting in router buffers) and **processing**. Light in fiber travels about **200,000 km/s** (two-thirds of its speed in vacuum).

```text
New York → London ≈ 5,600 km straight line
one-way propagation ≈ 5,600 / 200,000 s = 0.028 s = 28 ms
round trip (RTT)    ≈ 56 ms minimum; real cables aren't straight → ~70 ms typical

transmission of one 1,500-byte packet on a 100 Mbit/s link:
1,500 × 8 bits / 100,000,000 bits/s = 0.00012 s = 0.12 ms
```

Lesson: for small messages across the world, **distance dominates**. No amount of bandwidth makes London closer. That's why CDNs (Day 30) put servers near users.

## In an interview

You'll rarely get "explain IP" directly. Instead this knowledge shows up inside other answers: "the request goes to the load balancer's public IP, which forwards to app servers on private IPs in the VPC", "L4 vs L7 load balancer", "cross-region calls add ~70–150 ms RTT", "the client is behind NAT so the server can't connect to it — use WebSockets initiated by the client".

A good short answer to "how does a packet get from my laptop to a server?": *"The data is split into packets with IP headers carrying source and destination addresses. My laptop sends them to the default gateway, my home router, which NATs my private address to its public one. Each router on the way looks up the destination prefix in its routing table and forwards to the next hop, with BGP deciding paths between networks. At the server, IP gets the packet to the machine and the TCP port number gets it to the right process; TCP reorders and retransmits as needed."*

## Common mistakes

- **"The internet and the web are the same."** The web (HTTP, pages) is one application running on the internet. Email, DNS, games and SSH are others.
- **"An IP address identifies a person/computer forever."** It identifies an interface at a moment. Phones change IPs as they move; thousands of users may share one public IP via NAT.
- **"Packets follow a fixed path."** Each packet is routed independently and could take a different path, and may arrive out of order.
- **"More bandwidth = lower latency."** Bandwidth is how *much* per second; latency is how *long* one trip takes. A wider highway doesn't shorten the drive.
- **Mixing up ports and IPs.** IP = which machine; port = which program on that machine.

## Before moving on

- [ ] I can explain packets, IP addresses and routers with the postcard analogy
- [ ] I can name the four TCP/IP layers and what each layer's address is
- [ ] I can compute the number of addresses in a `/24` or `/20`
- [ ] I can explain how NAT lets many devices share one public IP, and its downside
- [ ] I can estimate an intercontinental round-trip time from distance

## Go deeper (optional)

- [Wikipedia: Internet protocol suite](https://en.wikipedia.org/wiki/Internet_protocol_suite)
- [Wikipedia: Network address translation](https://en.wikipedia.org/wiki/Network_address_translation)
- [Wikipedia: Border Gateway Protocol](https://en.wikipedia.org/wiki/Border_Gateway_Protocol)
- *Computer Networking: A Top-Down Approach* by Kurose and Ross
