---
title: Chrome device dimensions
section: Frontend
order: 1
last modified date: 2026-05-16
---

# Modern Device Dimensions for Chrome DevTools

These are modern “Emulated Devices” (a.k.a. *responsive dimensions*) for Chrome DevTools’ [*Mobile Device Viewport Mode*](https://developer.chrome.com/docs/devtools/device-mode/#device).

They are specifically Apple devices, **subtracting for recent Safari UI** (as in `window.innerWidth`/`Height`), and cleverly sorted with some dark-arts unicode shenanigans. (This glitchy, unloved portion of the tools sorts *lexicographically*, because of course it would.) Ergonomics!

 

> [!NOTE]  
> Updated June 2025 with some notes from folks below! **TL;DR: use [Vibranium!](#import--export)**
> 
> I’ll probably revisit the devices in the fall, come new iPhones and [*Liquid Glass*](https://mastodon.social/@tuomas_h/114672109542813969) making these numbers decreasingly relevant/accurate/helpful. Thanks, team.

<p align="center">
<img width="645" alt="Chrome’s DevTools showing a bunch of nonsensical devices, then a nice modern list instead." src="https://gist.github.com/assets/1929717/ca455366-6f2c-48b6-849f-e16700a78b11">
</p>


*Nest Hub Max*? Come on. I dropped a bunch of devices that were older and/or close to these dimensions. It obviously doesn’t cover everything (sorry Android/Chrome, Windows), but offers a decent spread/increments for common 2023/2024 viewports.

 

> [!WARNING]  
> Only edit the `Preferences` file(s) when Chrome is closed! Otherwise it’ll happily overwrite your work.

 

## Entering Them?

There seems to be no easy way to share or sync these, and [manually entering them](https://developer.chrome.com/docs/devtools/device-mode/#custom) is an error-prone disaster. So instead, we can overwrite the relevant portion of the profile’s (JSON…*ish?* Lots of quoting/escaping!) `Preferences` file (under `~/Library/Application Support/Google/Chrome/Profile #/`).

It’s probably easiest to just make one custom device, [then search for](https://scottwhittaker.net/posts/chrome-dev-tools-custom-emulated-device-list) the ~~`customEmulatedDeviceList`~~ (it’s changed!) `custom-emulated-device-list` key. VS Code’s *Format Document* ( <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>F</kbd> ) command makes these intelligible, and Chrome doesn’t seem to mind. Great.

Use the [`devtools.preferences.custom-emulated-device-list`](#file-devtools-preferences-custom-emulated-device-list) string below (long single line) for pasting in. Back in DevTools UI, you’ll need to uncheck any *Default devices* Chrome insists on adding for you below. *BlackBerry Z30!* 🙄

 

## Import / Export!

Friend of the Gist [@Pittan](https://github.com/Pittan) has written an *extremely* helpful CLI tool that can do the heavy lifting here, called [***Vibranium***](https://github.com/Pittan/vibranium). It slaps, particularly if you have a bunch of Google profiles and computers, as us dev-folk often do.

Use the [`vibranium.json`](#file-vibranium-json) below (actual, intelligible JSON!) to add the same values quickly. Thank you, Amon!

```sh
npx @pittankopta/vibranium add -r ~/Downloads/vibranium.json
```

<img alt="Terminal screenshot after running Vibranium, importing all the device sizes below." width="928" src="https://gist.github.com/user-attachments/assets/02abaabc-1139-4e0f-86c3-0b88df43efba">

<p align="center">
<sub><em>This shows my unicode sorting trick!</em></sub>
</p>

 

> [!TIP]
> If you’re skimming through here and comfortable on the command line (of course you are), this is the best way! 👆

 

## Actual Viewport Dimensions

And the list of dimensions, here for posterity/reference:

| Device                      | W (logical) | H (logical) | W (inner) | H (inner) | Notes |
|-----------------------------|-------------|-------------|-----------|-----------|-------|
| **iPhone SE**                   | 320         | 568         | 320       | 449       | *iOS 15.5. The last great iPhone chassis.* |
| **Common Android**              | 360         | 780         | 360       | 649       | *Galaxy S23 on Android 13 seemed indicative.* |
| **iPhone SE (3rd**)             | 375         | 667         | 375       | 547       | *iOS 17.2. Only remaining/current home-buttoned iPhone.* |
| **iPhone 15**                   | 390         | 844         | 393       | 659       | *iPhones Pro are the same this year.* |
| **iPhone 15 Plus**              | 428         | 926         | 430       | 739       | *These have the default bottom “Tab Bar” setting. Close enough to the `414px` of the X/11 era.* |
| **iPhone SE, landscape**        | 568         | 320         | 568       | 270       | *Tab bar is always at the top in landscape.* |
| **Common Android, landscape**   | 780         | 360         | 705       | 280       |  |
| **iPhone SE (3rd), landscape**  | 667         | 375         | 667       | 325       | *With the “Landscape Tab Bar” on—I think the default?* |
| **iPhone 15, landscape**        | 844         | 390         | 743       | 310       | *Multiple tabs visible. These are inside the left/right [safe areas](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).* |
| **iPhone 15 Plus, landscape**   | 926         | 428         | 814       | 347       |  |
| **iPad Mini (6th**)             | 744         | 1133        | 744       | 1026      | *Default “Separate Tab Bar” option, multiple tabs visible.* |
| **iPad (10th**)                 | 820         | 1180        | 820       | 1073      | *Same dimensions for the recent iPads Air. Close to 11" Pro.* |
| **iPad Pro (12.9")**            | 1024        | 1366        | 1024      | 1259      |  |
| **iPad Mini (6th), landscape**  | 1133        | 744         | 1133      | 637       |  |
| **iPad (10th), landscape**      | 1180        | 820         | 1180      | 713       |  |
| **iPad Pro (12.9"), landscape** | 1366        | 1024        | 1366      | 917       | *Very square.* |
| **MacBook Air (13")**           | 1280        | 832         | 1280      | 715       | *I think these still come scaled by default, but these are non-scaled. Maximized inside The Notch (`37px`, what?) and Safari (`80px`) toolbar, multiple tabs visible.* |
| **MacBook Air (15")**           | 1440        | 932         | 1440      | 815       |  |
| **MacBook Pro (14")**           | 1512        | 982         | 1512      | 865       | *Smaller, but more pixels.* |
| **MacBook Pro (16")**           | 1728        | 1117        | 1728      | 1000      | *Under the Menu Bar (`24px`) and Safari (`80px`).* |
| **iMac (24")**                  | 2240        | 1260        | 2240      | 1156      |  |
| **Studio Display**              | 2560        | 1440        | 2560      | 1336      |  |
| **Studio Display, half**        | 2560        | 1440        | 1278      | 1336      | *With the built-in MacOS tiling.* |
| **Pro Display XDR**             | 3008        | 1692        | 3008      | 1588      | *A designer can dream!* |

 
 
### Godspeed. ✊