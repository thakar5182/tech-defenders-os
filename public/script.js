// Register ScrollTrigger plugin
gsap.registerPlugin(ScrollTrigger);

// Initial Entrance Animation for Intro
const introTl = gsap.timeline();
introTl.to(".intro-word", {
    opacity: 1,
    y: 0,
    duration: 0.8,
    stagger: 0.15,
    ease: "back.out(1.2)",
    delay: 0.2
})
.to(".intro-sub", {
    opacity: 1,
    y: 0,
    duration: 0.8,
    ease: "power2.out"
}, "-=0.4")
.to(".scroll-indicator", {
    opacity: 0.6,
    duration: 1
}, "-=0.2");


// 1. Initial Setup for Laptop
// Camera looks DOWN at the closed laptop on the desk
gsap.set(".macbook-wrapper", {
    scale: 2.2,
    y: "40vh"
});
// Container is tilted (viewing desk from above)
gsap.set(".macbook", {
    rotateX: 70
});
// Lid is closed (lying flat on the desk, backwards)
gsap.set(".macbook-lid", {
    rotateX: 90 
});

// Calculate inner scroll distance dynamically
function getScrollDistance() {
    const innerContent = document.querySelector(".inner-website");
    const screenWrapper = document.querySelector(".lid-face.front > div");
    if(!innerContent || !screenWrapper) return 0;
    
    const distance = innerContent.offsetHeight - screenWrapper.offsetHeight;
    return distance > 0 ? -(distance + 50) : 0; 
}

// 2. Main Timeline tied to the .laptop-section scroll
const tl = gsap.timeline({
    scrollTrigger: {
        trigger: ".laptop-section",
        start: "top top", 
        end: "bottom bottom",
        scrub: 1, 
        invalidateOnRefresh: true, 
    }
});

// Fade out intro texts as we scroll down
tl.to(".intro", { opacity: 0, duration: 1 }, 0);

// Sequence A: Zoom out, open lid, AND move camera to look straight at the screen
tl.to(".macbook-wrapper", {
    scale: 1,
    y: "5vh",
    duration: 4,
    ease: "power2.inOut"
}, 0);

tl.to(".macbook", {
    // Camera tilts up to view the screen head-on (just a tiny bit of keyboard visible)
    rotateX: 5,
    duration: 4,
    ease: "power2.inOut"
}, 0);

tl.to(".macbook-lid", {
    // Lid opens up to stand vertically facing the camera
    rotateX: 0, 
    duration: 4,
    ease: "power2.inOut"
}, 0);

// Sequence B: Scroll the website content inside the laptop screen
tl.to(".inner-website", {
    y: () => getScrollDistance(),
    duration: 12,
    ease: "none"
}, 4); 

// Sequence C: Close lid and move camera back to looking down
tl.to(".macbook-lid", {
    rotateX: 90, 
    duration: 4,
    ease: "power2.inOut"
}, 16);

tl.to(".macbook", {
    rotateX: 70, 
    duration: 4,
    ease: "power2.inOut"
}, 16);

// Sequence D: Zoom out and fade
tl.to(".macbook-wrapper", {
    scale: 0.8,
    y: "-15vh",
    opacity: 0, 
    duration: 3,
    ease: "power2.inOut"
}, 20);

// 3. Outro Timeline
const outroTl = gsap.timeline({
    scrollTrigger: {
        trigger: ".outro",
        start: "top 60%",
        end: "center center",
        scrub: 1
    }
});

outroTl.to(".outro-content", {
    opacity: 1,
    scale: 1,
    duration: 1,
    ease: "power3.out" 
});
