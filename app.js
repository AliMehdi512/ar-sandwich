import * as THREE from "./three.module.js";
import { GLTFLoader } from "./GLTFLoader.js";

console.log("✅ Imports started");
console.log("THREE:", typeof THREE);
console.log("GLTFLoader:", typeof GLTFLoader);

// ============================================================================
// AR Application State
// ============================================================================
const appState = {
  scene: null,
  camera: null,
  renderer: null,
  productModel: null,
  xrSession: null,
  referenceSpace: null,
  hitTestSource: null,
  placeRequested: false,
  placedAnchors: [], // Track placed anchors and their associated models
  shadowPlane: null, // Shadow receiver plane
  isPlacingMode: true, // Flag for placement mode
};

// Diagnostics element for mobile debugging
let diagEl = null;

// Gesture tracking for rotate and scale
const gestureState = {
  touchStartDistance: 0,
  lastRotationY: 0,
  scale: 1,
  targetScale: 1,
};

// ============================================================================
// Initialize Three.js Scene and Renderer
// ============================================================================
async function initScene() {
  // Create scene
  appState.scene = new THREE.Scene();
  appState.scene.background = null; // Transparent for AR

  // Create camera (Three.js WebXR handles camera setup)
  appState.camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  // Create WebGL renderer with AR support
  appState.renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  appState.renderer.setSize(window.innerWidth, window.innerHeight);
  appState.renderer.xr.enabled = true;
  appState.renderer.outputEncoding = THREE.sRGBColorSpace;
  document.body.appendChild(appState.renderer.domElement);

  // Set up lighting for product preview
  setupLighting();

  // Create shadow receiver plane (subtle ground plane for realism)
  createShadowPlane();

  // Load the 3D model
  await loadModel();

  // Add a diagnostics overlay for mobile troubleshooting
  createDiagnosticsOverlay();

  // Handle window resize
  window.addEventListener("resize", onWindowResize);
}

// ============================================================================
// Setup Lighting
// ============================================================================
function setupLighting() {
  // Ambient light: provides base illumination from all directions
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  appState.scene.add(ambientLight);

  // Directional light: simulates sunlight, casts shadows
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 5, 5);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 1024;
  directionalLight.shadow.mapSize.height = 1024;
  directionalLight.shadow.camera.far = 50;
  appState.scene.add(directionalLight);

  // Hemisphere light: adds color to shadows (blue from sky)
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x8b9dc3, 0.5);
  appState.scene.add(hemisphereLight);
}

// ============================================================================
// Create Shadow Receiver Plane
// ============================================================================
function createShadowPlane() {
  // Create a subtle ground plane to receive shadows
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShadowMaterial({
    opacity: 0.2, // Very subtle shadow effect
  });
  appState.shadowPlane = new THREE.Mesh(geometry, material);
  appState.shadowPlane.receiveShadow = true;
  appState.shadowPlane.rotation.x = -Math.PI / 2; // Rotate to be horizontal
  appState.shadowPlane.position.y = -0.01; // Place just below origin to avoid z-fighting
  appState.shadowPlane.scale.set(0.5, 0.5, 0.5); // 50cm x 50cm
  appState.scene.add(appState.shadowPlane);
}

// ============================================================================
// Load GLB Model
// ============================================================================
async function loadModel() {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    console.log("Starting to load model...");
    
    loader.load(
      "fried+chicken+sandwich+3d+model.glb",
      (gltf) => {
        console.log("Model loaded successfully", gltf);
        appState.productModel = gltf.scene;
        appState.productModel.visible = false;

        // Enable shadows on the model
        appState.productModel.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        appState.scene.add(appState.productModel);
        console.log("Model added to scene");
        resolve();
      },
      (progress) => {
        const percent = (progress.loaded / progress.total) * 100;
        console.log(`Loading model: ${percent.toFixed(2)}%`);
      },
      (error) => {
        console.error("Error loading model:", error);
        reject(error);
      }
    );
  });
}

// ============================================================================
// Start AR Session
// ============================================================================
async function startAR() {
  try {
    // Check XR support
    if (!navigator.xr) {
      throw new Error("WebXR not supported on this device");
    }

    console.log("Requesting AR session...");

    // Request WebXR session with required features only
    appState.xrSession = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["anchors", "dom-overlay"],
      domOverlay: { root: document.body },
    });

    console.log("✅ AR session started");

    // Bind Three.js renderer to XR session
    appState.renderer.xr.setSession(appState.xrSession);

    // Request reference space (local space for hit-testing and anchoring)
    appState.referenceSpace = await appState.xrSession.requestReferenceSpace(
      "local"
    );

    // Set up hit-testing: test against horizontal planes (tables)
    const viewerSpace = await appState.xrSession.requestReferenceSpace("viewer");
    try {
      appState.hitTestSource = await appState.xrSession.requestHitTestSource({
        space: viewerSpace,
        // Some runtimes support plane detection via entityTypes; try and fall back if unsupported
        entityTypes: ["plane"],
        offsetRay: new XRRay({ y: 0.5 }),
      });
    } catch (e) {
      // Fallback: try requesting a basic hit test source without entityTypes/offsetRay
      try {
        appState.hitTestSource = await appState.xrSession.requestHitTestSource({ space: viewerSpace });
        diagLog('Hit-test created (fallback)');
      } catch (err) {
        console.warn('Hit-test not available:', err);
        diagLog('Hit-test not available');
        appState.hitTestSource = null;
      }
    }

    console.log("✅ Hit-test source created");

    // Start the XR render loop
    appState.renderer.setAnimationLoop((time, frame) =>
      onXRFrame(time, frame)
    );

    // Set up UI event listeners
    setupUIListeners();

    // Hide the start button and show status
    document.getElementById("startAR").style.display = "none";
    document.getElementById("status").style.display = "block";
    updateStatus("Ready to place model. Tap screen to place.");

    console.log("✅ AR ready for interaction");
    diagLog('AR session started');
  } catch (error) {
    console.error("❌ Failed to start AR:", error.message);
    diagLog(`startAR error: ${error.message}`);
    alert(`AR not available: ${error.message}\n\nNote: WebXR requires a compatible mobile device with AR support (Android Chrome or iOS Safari 16+)`);
  }
}

// ============================================================================
// Setup UI Listeners
// ============================================================================
function setupUIListeners() {
  // Screen tap to place model
  appState.renderer.domElement.addEventListener("click", async () => {
    // If XR session isn't started yet, start it using this user gesture.
    // Some users tap the scene instead of the 'View in AR' button.
    if (!appState.xrSession) {
      try {
        await startAR();
        // After starting, mark a placement request so this tap places the model.
        appState.placeRequested = true;
      } catch (e) {
        console.warn('startAR failed from tap:', e);
      }
      return;
    }

    // Normal placing flow when session already running
    if (appState.isPlacingMode) {
      appState.placeRequested = true;
    }
  });

  // Multi-touch gestures for rotation and scale
  appState.renderer.domElement.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && appState.placedAnchors.length > 0) {
      e.preventDefault();
      handleTwoFingerGesture(e);
    }
  });

  // Handle touch end
  appState.renderer.domElement.addEventListener("touchend", () => {
    gestureState.touchStartDistance = 0;
    gestureState.scale = gestureState.targetScale;
  });

  // Reset button
  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetAR);
  }

  // Show control panel during AR
  const controlPanel = document.getElementById("controlPanel");
  if (controlPanel) {
    controlPanel.style.display = "flex";
  }

  // Show hints
  const hints = document.getElementById("hints");
  if (hints) {
    hints.style.display = "block";
  }
}

// ============================================================================
// Handle Multi-Touch Gestures (Rotate + Scale)
// ============================================================================
function handleTwoFingerGesture(event) {
  const touch1 = event.touches[0];
  const touch2 = event.touches[1];

  const dx = touch2.clientX - touch1.clientX;
  const dy = touch2.clientY - touch1.clientY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (gestureState.touchStartDistance === 0) {
    gestureState.touchStartDistance = distance;
  } else {
    // Scale gesture
    const scaleFactor = distance / gestureState.touchStartDistance;
    gestureState.targetScale = Math.max(0.5, Math.min(3, scaleFactor * gestureState.scale));

    // Rotation gesture (vertical swipe rotates)
    const rotationDelta = dy * 0.01;
    gestureState.lastRotationY += rotationDelta;
  }
}

// ============================================================================
// Main XR Frame Loop
// ============================================================================
function onXRFrame(time, frame) {
  // Early exit if no hit test source or no session
  if (!frame) return;

  // Perform hit-testing to detect horizontal planes (tables)
  let hitTestResults = [];
  if (appState.hitTestSource) {
    try {
      hitTestResults = frame.getHitTestResults(appState.hitTestSource);
    } catch (e) {
      console.warn('getHitTestResults failed', e);
      diagLog('getHitTestResults failed');
    }
  }

  // Place model on user tap
  if (
    hitTestResults.length > 0 &&
    appState.placeRequested &&
    appState.productModel &&
    appState.isPlacingMode
  ) {
    placeModelOnPlane(hitTestResults[0], frame);
    appState.placeRequested = false;
  }

  // Update tracked anchors (models already placed stay in position)
  updatePlacedAnchors(frame);

  // Render the scene
  appState.renderer.render(appState.scene, appState.camera);
}

// ============================================================================
// Place Model on Detected Plane
// ============================================================================
function placeModelOnPlane(hitResult, frame) {
  const pose = hitResult.getPose(appState.referenceSpace);

  if (!pose || !pose.transform) {
    console.warn("Unable to get pose for hit test result");
    return;
  }

  // Try to create an anchor if supported; otherwise just attach model at the pose
  const placeWithAnchor = async () => {
    try {
      if (typeof frame.createAnchor === 'function') {
        const anchor = await frame.createAnchor(pose.transform, appState.referenceSpace);
        const modelClone = appState.productModel.clone();
        modelClone.visible = true;
        anchor.userData = { model: modelClone };
        appState.placedAnchors.push(anchor);
        appState.scene.add(modelClone);
        console.log('Model placed at anchor. Total placed:', appState.placedAnchors.length);
        diagLog('Model placed with anchor');
      } else {
        // Anchor not available: create a regular Object3D and position it
        const modelClone = appState.productModel.clone();
        modelClone.visible = true;
        modelClone.matrix.fromArray(pose.transform.matrix);
        modelClone.matrix.decompose(modelClone.position, modelClone.quaternion, modelClone.scale);
        modelClone.matrixAutoUpdate = false;
        appState.scene.add(modelClone);
        console.log('Model placed without anchor');
        diagLog('Model placed without anchor');
      }

      appState.isPlacingMode = false;
      updateStatus('Model placed!');
    } catch (err) {
      console.error('Failed to place model:', err);
      diagLog('Failed to place model: ' + err.message);
    }
  };

  placeWithAnchor();
}

// ============================================================================
// Update Placed Anchors (Persist Position)
// ============================================================================
function updatePlacedAnchors(frame) {
  // Iterate through all tracked anchors
  for (const anchor of frame.trackedAnchors) {
    if (!anchor.userData?.model) continue;

    // Get the current pose of this anchor in reference space
    const pose = frame.getPose(anchor.anchorSpace, appState.referenceSpace);

    if (pose) {
      const model = anchor.userData.model;

      // Update model's transformation matrix from anchor pose
      // The anchor's pose includes rotation, translation, and scale
      model.matrix.fromArray(pose.transform.matrix);
      model.matrixAutoUpdate = false; // We're manually setting matrix

      // Apply gesture scale and rotation
      if (appState.placedAnchors.includes(anchor)) {
        model.scale.multiplyScalar(gestureState.scale);
        model.rotateY(gestureState.lastRotationY);
      }
    }
  }
}

// ============================================================================
// Reset AR Scene (Remove all placed models)
// ============================================================================
function resetAR() {
  // Remove all cloned models from scene
  for (const anchor of appState.placedAnchors) {
    if (anchor.userData?.model) {
      appState.scene.remove(anchor.userData.model);
    }
  }

  // Clear anchors and reset state
  appState.placedAnchors = [];
  appState.isPlacingMode = true;
  gestureState.scale = 1;
  gestureState.targetScale = 1;
  gestureState.lastRotationY = 0;

  updateStatus("Ready to place model. Tap screen to place.");
}

// ============================================================================
// Non-XR preview fallback for desktop/mobile browsers without device AR
// Shows the model in the Three.js scene and enables simple touch/mouse controls
// ============================================================================
function enableNonXRPreview() {
  diagLog('Enabling non-XR preview');
  if (!appState.productModel) return;

  // Make model visible and position it in front of camera
  appState.productModel.visible = true;
  appState.productModel.position.set(0, -0.3, -0.6);
  appState.productModel.lookAt(new THREE.Vector3(0, 0, 0));

  // Simple orbit-like controls: drag to rotate, pinch to scale
  let isPointerDown = false;
  let lastX = 0;
  let lastY = 0;

  appState.renderer.domElement.addEventListener('pointerdown', (e) => {
    isPointerDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('pointerup', () => (isPointerDown = false));

  appState.renderer.domElement.addEventListener('pointermove', (e) => {
    if (!isPointerDown) return;
    const dx = (e.clientX - lastX) * 0.01;
    const dy = (e.clientY - lastY) * 0.01;
    appState.productModel.rotateY(dx);
    appState.productModel.rotateX(dy);
    lastX = e.clientX;
    lastY = e.clientY;
  });

  // Touch pinch for scale
  let pinchStart = 0;
  appState.renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      pinchStart = Math.hypot(dx, dy);
    }
  });
  appState.renderer.domElement.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStart > 0) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const d = Math.hypot(dx, dy);
      const scale = THREE.MathUtils.clamp((d / pinchStart) * appState.productModel.scale.x, 0.3, 3);
      appState.productModel.scale.setScalar(scale);
    }
  });

  // Render loop for non-XR preview
  appState.renderer.setAnimationLoop(() => {
    appState.renderer.render(appState.scene, appState.camera);
  });
}

// ============================================================================
// Update Status Display
// ============================================================================
function updateStatus(message) {
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.textContent = message;
  }
}

// ============================================================================
// Window Resize Handler
// ============================================================================
function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  appState.camera.aspect = width / height;
  appState.camera.updateProjectionMatrix();
  appState.renderer.setSize(width, height);
}

// ============================================================================
// Diagnostics Overlay (helps debug on mobile without remote console)
// ============================================================================
function createDiagnosticsOverlay() {
  const diag = document.createElement('div');
  diag.id = 'diagnostics';
  diag.style.position = 'absolute';
  diag.style.top = '8px';
  diag.style.right = '8px';
  diag.style.zIndex = '9999';
  diag.style.padding = '8px 12px';
  diag.style.background = 'rgba(0,0,0,0.6)';
  diag.style.color = 'white';
  diag.style.fontSize = '12px';
  diag.style.borderRadius = '6px';
  diag.style.maxWidth = '220px';
  diag.style.lineHeight = '1.3';
  diag.innerHTML = '<strong>Diagnostics</strong><br>Checking...';
  document.body.appendChild(diag);

  // Check basic capabilities
  (async () => {
    const parts = [];
    parts.push(`<div style="word-break:break-word">UA: ${navigator.userAgent}</div>`);

    if (navigator.xr && navigator.xr.isSessionSupported) {
      try {
        const supported = await navigator.xr.isSessionSupported('immersive-ar');
        parts.push(`<div>immersive-ar: ${supported}</div>`);
      } catch (e) {
        parts.push(`<div>immersive-ar: error</div>`);
      }
    } else {
      parts.push('<div>WebXR: not available</div>');
    }

    // camera permission state (may not be supported by all browsers)
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const p = await navigator.permissions.query({ name: 'camera' });
        parts.push(`<div>camera perm: ${p.state}</div>`);
      } catch (e) {
        // ignore
      }
    }

    diag.innerHTML = '<strong>Diagnostics</strong><br>' + parts.join('');
    diagEl = diag;
  })();
}

function diagLog(msg) {
  try {
    console.log('DIAG:', msg);
    if (diagEl) {
      const p = document.createElement('div');
      p.textContent = msg;
      diagEl.appendChild(p);
    }
  } catch (e) {
    console.warn('diagLog failed', e);
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================
async function main() {
  try {
    // Initialize scene first
    console.log("Initializing scene...");
    await initScene();
    console.log("Scene initialized successfully");

    // Attach start AR handler
    const startBtn = document.getElementById("startAR");
    if (startBtn) {
      startBtn.addEventListener("click", startAR);
      console.log("AR button ready");
    }

    // Check WebXR support
    if (!navigator.xr) {
      console.warn("WebXR not supported on this device");
      alert("WebXR not supported on this device");
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = "❌ WebXR Not Supported";
      }
      // Fallback: show model in-screen for desktop users
      enableNonXRPreview();
    } else {
      console.log("WebXR is available");
      // Check whether immersive-ar is actually supported, otherwise fallback
      try {
        const supported = await navigator.xr.isSessionSupported('immersive-ar');
        console.log('immersive-ar supported:', supported);
        if (!supported) {
          enableNonXRPreview();
        }
      } catch (e) {
        console.warn('isSessionSupported call failed', e);
        enableNonXRPreview();
      }
    }
  } catch (error) {
    console.error("Failed to initialize app:", error);
    alert("Error initializing AR app: " + error.message);
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
