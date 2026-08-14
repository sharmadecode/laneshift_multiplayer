Right now, focus on making one 500-metre stretch of highway feel premium before adding a huge world or many cars. Good graphics come from lighting, road detail, atmosphere, motion, and feedback—not only expensive 3D car models.

## Visual direction

Choose this style:

> Realistic night highway, wet/dark asphalt, distant city glow, fast-moving streetlights, white headlights, red taillights, blue-black sky, dense fog, subtle neon signage.

It can feel cinematic and premium on mobile without trying to copy Assetto Corsa’s extreme realism.

## Build graphics in this order

### 1. Make the road look real

Your road is the screen’s biggest object, so improve it first.

Add:

- Asphalt texture with roughness and normal map
- Slightly reflective road surface
- Bright lane lines with emissive glow
- Road shoulders, barriers, guardrails, reflectors
- Repeating road cracks/oil stains/decal variations
- Streetlights every 30–50 metres
- Small reflective lane studs

Use repeating tiled textures and recycled road chunks. Do not use one giant road mesh.

### 2. Add night lighting and atmosphere

Use a small number of lights intelligently:

- Dark blue ambient/night sky light
- Directional moonlight
- Player headlights that light the road ahead
- Red taillights on all cars
- Streetlight pools of warm light
- Distant building/window emission
- Exponential fog
- ACES filmic tone mapping
- Controlled bloom only for emissive lights

The fog is very important: it hides repeated scenery, makes the road feel endless, and improves performance because you do not need to draw far-away detail.

### 3. Make the player car feel special

Even before downloading a realistic vehicle, improve the existing placeholder car:

- Better proportions: low, wide, sporty
- Metallic body paint
- Dark glass windows
- Wheel rims, brake discs, tyres
- Headlight lens with glow
- Brake light activation
- Emissive dashboard/interior glow
- A reflection/environment map
- Smooth body roll during steering
- Wheel rotation based on speed

Use one hero player car first. It should be shown close to the camera and be your highest-quality vehicle.

### 4. Improve traffic variety

Traffic should look believable through variety, not ultra-high polygon counts.

Use these categories:

- Sedan
- SUV
- Hatchback
- Sports coupe
- Van
- Truck
- Bus
- Taxi

Give every traffic car:

- Random legal colours
- Different speed ranges
- Working headlights and taillights
- Slight lane-centre variation
- Different lengths/heights
- Occasional braking lights

Use low-detail models at distance and higher detail only for nearby cars.

### 5. Build a procedural city background

Do not manually create a huge city.

Create a set of repeated environment pieces:

```text
Highway segment
Streetlight segment
Barrier segment
Billboard segment
Small building cluster
Tall building cluster
Industrial warehouse cluster
Overpass / bridge segment
Tunnel segment
Petrol station / rest-stop segment
```

Randomly place them as road chunks recycle behind the player.

Use:

- Instanced buildings
- Emissive window textures
- Billboard signs
- Distant skyline silhouettes
- Animated neon signs
- Occasional overpass to break repetition

## Make the driving feel exciting

Graphics alone will not make it fun. Add feedback.

### Camera

- Increase FOV as speed increases
- Small camera shake only on impact or rough road
- Smooth camera lean while steering
- Slight camera lift/drop during acceleration and braking
- Brief motion streaks at very high speed, but avoid heavy blur on mobile

### Speed feeling

- Wind sound rises with speed
- Engine pitch changes with RPM/speed
- Road markings appear to move faster
- Streetlights flash past
- FOV widens
- Tiny particles/dust at the road edge
- Screen vignette becomes slightly stronger at high speed

### Collision feedback

When the server confirms a crash:

```text
impact sound
→ camera shake
→ sparks/debris
→ brake lights / hazard flash
→ speed drops to zero
→ three-second respawn timer
→ ghost protection after respawn
```

Do not make crashes too punishing early in the game. Make the player want “one more run.”

## Add gameplay beyond only driving

Your first gameplay loop should be:

```text
Drive fast
→ pass close to traffic
→ earn score multiplier
→ avoid crashes
→ survive increasing traffic density
→ compete with friends for distance/score
```

Add these mechanics:

- Distance score
- Speed bonus
- Near-miss bonus
- Overtake bonus
- Combo multiplier for consecutive close passes
- Crash resets the combo
- Personal best
- Room leaderboard
- Optional 5 km / 10 km / 20 km races

Later additions:

- Day/night themes
- Rain
- Different highways
- Traffic density modes
- Cosmetic car colours
- Car unlocks
- Weekly challenge

## Mobile performance rules

For Android, do not add every effect everywhere.

| Feature | Use |
|---|---|
| High-poly player car | Yes, one close car |
| Low-poly traffic | Yes |
| Instanced scenery | Yes |
| Fog | Yes |
| Bloom | Medium/High only |
| Dynamic shadows on every car | No |
| Huge 4K textures | No |
| Reflections on all traffic cars | No |
| Motion blur | Avoid for v1 |

Aim for:

- Low: stable 30 FPS
- Medium: 45–60 FPS
- High: 60 FPS on strong phones and desktop

## Exact visual implementation order

1. Better road materials, barriers, lane reflectors, road texture.
2. Proper night sky, fog, moonlight, streetlights, bloom.
3. Upgrade the placeholder player car with PBR paint, glass, wheels, headlights, taillights.
4. Add traffic taillights/headlights and colour variation.
5. Add procedural buildings, billboards, skyline, overpasses.
6. Add engine, wind, tyre, crash, and near-miss audio.
7. Add camera speed effects and crash feedback.
8. Add score, near miss, combo, leaderboard, and game-over/race UI.
9. Profile on Android after every visual step.
10. Only then import optimized real car assets.

Give this to the helper model as its next visual task:

For this game, I would use a mixed pack strategy—not one “realistic” pack for everything.

The strongest free starting choice is **RGS_Dev’s Free Low Poly Vehicles Pack**: it has sedans, sports cars, SUVs, vans, buses, trucks, taxi, emergency vehicles, separated wheels, and tintable materials. It is CC0, so it can be used commercially; still credit the creator in your credits screen. It is ideal for your highway traffic. [RGS_Dev vehicle pack](https://rgsdev.itch.io/free-low-poly-vehicles-pack)

Use these sources in this order:

| Use in game | Best source | Why |
|---|---|---|
| Traffic cars | [RGS_Dev Vehicle Pack](https://rgsdev.itch.io/free-low-poly-vehicles-pack) | Large, varied, game-ready CC0 pack |
| Extra traffic cars | [Kenney Car Kit](https://www.kenney.nl/assets/car-kit) | 45 CC0 vehicle assets, lightweight |
| Extra cars / variants | [Quaternius Cars Pack](https://quaternius.com/packs/cars.html) | Eight CC0 car models; commercial use allowed |
| One or two better hero/player cars | [Sketchfab downloadable commercial-use models](https://sketchfab.com/tags/commercial-use) | Best chance of finding more detailed free models |
| Single filler vehicles | [Poly Pizza](https://poly.pizza/) | Direct GLTF/FBX downloads; check every model’s license |

The realistic truth: there is **no trustworthy, big, totally free, photorealistic car pack** that is automatically safe for a Play Store release. Free realistic cars are usually individual uploads, often branded, overly high-poly, or have restricted licenses.

For your player cars, use Sketchfab carefully:

1. Search for generic names like “sports coupe,” “supercar concept,” “street car,” or “racing coupe.”
2. Require: downloadable + **CC0** or **CC BY** only.
3. Do not use **NC**, **ND**, Editorial, ripped game models, or models that say they came from Assetto Corsa, GTA, Forza, Real Racing, etc.
4. Avoid branded models such as “Lamborghini,” “BMW,” “Mustang,” or “Nissan”—even if a model uploader picked CC BY. The uploader may not own the brand/trade-dress rights.
5. Download manually, retain the model page URL and license screenshot, then optimize it before placing it in the game.

Sketchfab’s CC0 assets can be used without attribution; CC BY assets can be used commercially but require proper creator credit. [Sketchfab license explanation](https://sketchfab.com/blogs/community/refine-downloadable-model-searches-with-new-license-filters/)

Use this exact credits format in an in-game **Credits & Licenses** page and in `assets/CREDITS.md`:

```text
Traffic Vehicle Pack
Creator: RGS_Dev
Source: https://rgsdev.itch.io/free-low-poly-vehicles-pack
License: CC0 1.0 Universal

Player Car: “Concept Coupe”
Creator: [Creator name]
Source: [exact model page URL]
License: CC BY 4.0
Modified by: Highway Rush team
```

For the first release, I recommend:

- 1 custom-looking unbranded “concept coupe” as the main player car
- 1 unbranded “hyper coupe” unlockable player car
- RGS_Dev pack for almost all highway traffic
- Kenney/Quaternius models only as far-distance or lower-graphics traffic variants
- No car logos, badges, names, or real license plates

Before adding any vehicle, make the coding agent run this asset pipeline:

```text
Download source file
→ verify exact license and save source URL
→ open in Blender
→ remove logos/badges/plates
→ target 5k–15k triangles for close mobile cars
→ create lower-detail LOD version
→ resize to real-world metres
→ set car forward direction and wheel positions
→ export compressed .glb
→ test on Android
→ add credit entry
```

Do not use a free model with 1 million triangles: it may look good in a model viewer but will ruin Android performance. Better lighting, reflections, clean materials, headlights, fog, and camera effects will make optimized 3D cars look much more premium than raw high-poly downloads.