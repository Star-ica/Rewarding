// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Rewarding
 * @notice Multi-project token distribution platform with Merkle-proof whitelisting
 * @dev Supports ERC-20 token campaigns with Merkle or direct-registration whitelists
 */
contract Rewarding is ReentrancyGuard, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    // ─── Roles ────────────────────────────────────────────────────────────────
    bytes32 public constant PLATFORM_ADMIN = keccak256("PLATFORM_ADMIN");
    bytes32 public constant PROJECT_OWNER  = keccak256("PROJECT_OWNER");

    // ─── Platform config ──────────────────────────────────────────────────────
    uint256 public platformFeeBps;          // basis points (100 = 1%)
    uint256 public constant MAX_FEE_BPS = 500; // 5% ceiling
    address public feeRecipient;

    // ─── Counters ─────────────────────────────────────────────────────────────
    uint256 private _projectIdCounter;
    uint256 private _campaignIdCounter;

    // ─── Structs ──────────────────────────────────────────────────────────────
    struct Project {
        uint256 id;
        address owner;
        string  name;
        string  logoURI;       // IPFS CID or data URI
        string  description;
        string  website;
        string  twitter;
        string  discord;
        bool    active;
        uint256 createdAt;
    }

    enum WhitelistMode { MERKLE, DIRECT }
    enum CampaignStatus { ACTIVE, PAUSED, CLOSED, EXPIRED }

    struct Campaign {
        uint256   id;
        uint256   projectId;
        string    name;
        string    description;
        address   token;           // address(0) = native token
        uint256   totalAllocation; // total tokens deposited
        uint256   claimedAmount;
        uint256   startTime;
        uint256   endTime;
        bytes32   merkleRoot;      // 0x0 if DIRECT mode
        WhitelistMode whitelistMode;
        CampaignStatus status;
        bool      allowPartialClaim;  // allow claim < full allocation
        uint256   vestingDuration;    // 0 = no vesting, else seconds until full
        address   funder;
    }

    // ─── Mappings ─────────────────────────────────────────────────────────────
    mapping(uint256 => Project)  public projects;
    mapping(address => uint256)  public ownerToProjectId; // 1 project per wallet (extendable)
    mapping(uint256 => Campaign) public campaigns;

    // campaignId => wallet => claimed
    mapping(uint256 => mapping(address => bool))    public hasClaimed;
    // campaignId => wallet => amount (direct mode)
    mapping(uint256 => mapping(address => uint256)) public directAllocation;
    // campaignId => wallet => amount already claimed (vesting partial)
    mapping(uint256 => mapping(address => uint256)) public claimedByUser;

    // projectId => campaignIds[]
    mapping(uint256 => uint256[]) public projectCampaigns;

    // ─── Events ───────────────────────────────────────────────────────────────
    event ProjectCreated(uint256 indexed projectId, address indexed owner, string name);
    event ProjectUpdated(uint256 indexed projectId);
    event CampaignCreated(uint256 indexed campaignId, uint256 indexed projectId, address token, uint256 allocation);
    event CampaignFunded(uint256 indexed campaignId, uint256 amount);
    event CampaignStatusChanged(uint256 indexed campaignId, CampaignStatus status);
    event MerkleRootUpdated(uint256 indexed campaignId, bytes32 root);
    event DirectAllocationSet(uint256 indexed campaignId, address indexed wallet, uint256 amount);
    event TokensClaimed(uint256 indexed campaignId, address indexed claimant, uint256 amount);
    event UnclaimedRefunded(uint256 indexed campaignId, address indexed recipient, uint256 amount);
    event PlatformFeeUpdated(uint256 feeBps);
    event FeeRecipientUpdated(address recipient);

    // ─── Errors ───────────────────────────────────────────────────────────────
    error ProjectNotFound();
    error CampaignNotFound();
    error NotProjectOwner();
    error CampaignNotActive();
    error CampaignNotExpired();
    error AlreadyClaimed();
    error NotWhitelisted();
    error InvalidProof();
    error InvalidAllocation();
    error CampaignOverfunded();
    error ZeroAddress();
    error InvalidTimeRange();
    error NativeTransferFailed();
    error InvalidFee();
    error VestingNotStarted();
    error NothingToClaim();

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _feeRecipient, uint256 _feeBps) {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert InvalidFee();
        feeRecipient = _feeRecipient;
        platformFeeBps = _feeBps;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PLATFORM_ADMIN, msg.sender);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyProjectOwner(uint256 projectId) {
        if (projects[projectId].owner != msg.sender) revert NotProjectOwner();
        _;
    }

    modifier campaignExists(uint256 campaignId) {
        if (campaigns[campaignId].funder == address(0)) revert CampaignNotFound();
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROJECT MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new project profile. One project per wallet.
     */
    function createProject(
        string calldata name,
        string calldata logoURI,
        string calldata description,
        string calldata website,
        string calldata twitter,
        string calldata discord
    ) external whenNotPaused returns (uint256 projectId) {
        // allow multiple projects per owner — owner tracks via events/indexer
        unchecked { projectId = ++_projectIdCounter; }
        projects[projectId] = Project({
            id:          projectId,
            owner:       msg.sender,
            name:        name,
            logoURI:     logoURI,
            description: description,
            website:     website,
            twitter:     twitter,
            discord:     discord,
            active:      true,
            createdAt:   block.timestamp
        });
        _grantRole(PROJECT_OWNER, msg.sender);
        emit ProjectCreated(projectId, msg.sender, name);
    }

    function updateProject(
        uint256 projectId,
        string calldata name,
        string calldata logoURI,
        string calldata description,
        string calldata website,
        string calldata twitter,
        string calldata discord
    ) external onlyProjectOwner(projectId) {
        Project storage p = projects[projectId];
        p.name        = name;
        p.logoURI     = logoURI;
        p.description = description;
        p.website     = website;
        p.twitter     = twitter;
        p.discord     = discord;
        emit ProjectUpdated(projectId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CAMPAIGN CREATION & FUNDING
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a campaign. Token allocation is deposited at creation.
     * @param token address(0) for native chain token (BOT/ETH etc.)
     * @param merkleRoot 0x0 for DIRECT whitelist mode
     */
    function createCampaign(
        uint256   projectId,
        string    calldata name,
        string    calldata description,
        address   token,
        uint256   totalAllocation,
        uint256   startTime,
        uint256   endTime,
        bytes32   merkleRoot,
        WhitelistMode whitelistMode,
        bool      allowPartialClaim,
        uint256   vestingDuration
    ) external payable whenNotPaused onlyProjectOwner(projectId) nonReentrant returns (uint256 campaignId) {
        if (endTime <= startTime || startTime < block.timestamp) revert InvalidTimeRange();
        if (totalAllocation == 0) revert InvalidAllocation();

        uint256 fee = (totalAllocation * platformFeeBps) / 10_000;
        uint256 required = totalAllocation + fee;

        if (token == address(0)) {
            // Native token campaign
            if (msg.value < required) revert CampaignOverfunded();
            if (fee > 0) {
                (bool ok,) = feeRecipient.call{value: fee}("");
                if (!ok) revert NativeTransferFailed();
            }
        } else {
            if (msg.value != 0) revert CampaignOverfunded();
            IERC20(token).safeTransferFrom(msg.sender, address(this), required);
            if (fee > 0) {
                IERC20(token).safeTransfer(feeRecipient, fee);
            }
        }

        unchecked { campaignId = ++_campaignIdCounter; }
        campaigns[campaignId] = Campaign({
            id:               campaignId,
            projectId:        projectId,
            name:             name,
            description:      description,
            token:            token,
            totalAllocation:  totalAllocation,
            claimedAmount:    0,
            startTime:        startTime,
            endTime:          endTime,
            merkleRoot:       merkleRoot,
            whitelistMode:    whitelistMode,
            status:           CampaignStatus.ACTIVE,
            allowPartialClaim: allowPartialClaim,
            vestingDuration:  vestingDuration,
            funder:           msg.sender
        });
        projectCampaigns[projectId].push(campaignId);

        emit CampaignCreated(campaignId, projectId, token, totalAllocation);
        emit CampaignFunded(campaignId, totalAllocation);
    }

    /**
     * @notice Update the Merkle root (for MERKLE mode campaigns before claims begin).
     */
    function updateMerkleRoot(uint256 campaignId, bytes32 newRoot)
        external
        campaignExists(campaignId)
    {
        Campaign storage c = campaigns[campaignId];
        if (projects[c.projectId].owner != msg.sender) revert NotProjectOwner();
        // Can only update if no claims have been made
        require(c.claimedAmount == 0, "Claims already started");
        c.merkleRoot = newRoot;
        emit MerkleRootUpdated(campaignId, newRoot);
    }

    /**
     * @notice Set direct allocations (DIRECT mode only, batch).
     */
    function setDirectAllocations(
        uint256 campaignId,
        address[] calldata wallets,
        uint256[] calldata amounts
    ) external campaignExists(campaignId) {
        Campaign storage c = campaigns[campaignId];
        if (projects[c.projectId].owner != msg.sender) revert NotProjectOwner();
        require(c.whitelistMode == WhitelistMode.DIRECT, "Not DIRECT mode");
        require(wallets.length == amounts.length, "Length mismatch");
        require(c.claimedAmount == 0, "Claims already started");

        for (uint256 i; i < wallets.length; ) {
            directAllocation[campaignId][wallets[i]] = amounts[i];
            emit DirectAllocationSet(campaignId, wallets[i], amounts[i]);
            unchecked { ++i; }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CLAIMING
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Claim tokens using a Merkle proof.
     * @param amount The allocation registered in the Merkle leaf
     * @param proof  The Merkle siblings path
     */
    function claimMerkle(
        uint256 campaignId,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant whenNotPaused campaignExists(campaignId) {
        Campaign storage c = campaigns[campaignId];
        _assertClaimable(c);
        if (c.whitelistMode != WhitelistMode.MERKLE) revert NotWhitelisted();
        if (hasClaimed[campaignId][msg.sender]) revert AlreadyClaimed();

        // Verify proof: leaf = keccak256(abi.encodePacked(wallet, amount))
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verify(proof, c.merkleRoot, leaf)) revert InvalidProof();

        uint256 claimable = _vestingClaimable(c, amount, campaignId);
        if (claimable == 0) revert NothingToClaim();

        claimedByUser[campaignId][msg.sender] += claimable;
        // Mark fully claimed only when full allocation is taken
        if (claimedByUser[campaignId][msg.sender] >= amount) {
            hasClaimed[campaignId][msg.sender] = true;
        }
        c.claimedAmount += claimable;

        _disburse(c.token, msg.sender, claimable);
        emit TokensClaimed(campaignId, msg.sender, claimable);
    }

    /**
     * @notice Claim tokens in DIRECT whitelist mode.
     */
    function claimDirect(uint256 campaignId)
        external
        nonReentrant
        whenNotPaused
        campaignExists(campaignId)
    {
        Campaign storage c = campaigns[campaignId];
        _assertClaimable(c);
        if (c.whitelistMode != WhitelistMode.DIRECT) revert NotWhitelisted();
        if (hasClaimed[campaignId][msg.sender]) revert AlreadyClaimed();

        uint256 amount = directAllocation[campaignId][msg.sender];
        if (amount == 0) revert NotWhitelisted();

        uint256 claimable = _vestingClaimable(c, amount, campaignId);
        if (claimable == 0) revert NothingToClaim();

        claimedByUser[campaignId][msg.sender] += claimable;
        if (claimedByUser[campaignId][msg.sender] >= amount) {
            hasClaimed[campaignId][msg.sender] = true;
        }
        c.claimedAmount += claimable;

        _disburse(c.token, msg.sender, claimable);
        emit TokensClaimed(campaignId, msg.sender, claimable);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CAMPAIGN ADMINISTRATION
    // ══════════════════════════════════════════════════════════════════════════

    function pauseCampaign(uint256 campaignId)
        external
        campaignExists(campaignId)
    {
        Campaign storage c = campaigns[campaignId];
        bool isOwner  = projects[c.projectId].owner == msg.sender;
        bool isAdmin  = hasRole(PLATFORM_ADMIN, msg.sender);
        require(isOwner || isAdmin, "Unauthorized");
        require(c.status == CampaignStatus.ACTIVE, "Not active");
        c.status = CampaignStatus.PAUSED;
        emit CampaignStatusChanged(campaignId, CampaignStatus.PAUSED);
    }

    function resumeCampaign(uint256 campaignId)
        external
        campaignExists(campaignId)
        onlyProjectOwner(campaigns[campaignId].projectId)
    {
        Campaign storage c = campaigns[campaignId];
        require(c.status == CampaignStatus.PAUSED, "Not paused");
        c.status = CampaignStatus.ACTIVE;
        emit CampaignStatusChanged(campaignId, CampaignStatus.ACTIVE);
    }

    function closeCampaign(uint256 campaignId)
        external
        campaignExists(campaignId)
        onlyProjectOwner(campaigns[campaignId].projectId)
    {
        Campaign storage c = campaigns[campaignId];
        require(c.status != CampaignStatus.CLOSED, "Already closed");
        c.status = CampaignStatus.CLOSED;
        emit CampaignStatusChanged(campaignId, CampaignStatus.CLOSED);
    }

    /**
     * @notice Refund unclaimed tokens after campaign end. Anyone can trigger.
     */
    function refundUnclaimed(uint256 campaignId)
        external
        nonReentrant
        campaignExists(campaignId)
    {
        Campaign storage c = campaigns[campaignId];
        bool expired = block.timestamp > c.endTime;
        bool closed  = c.status == CampaignStatus.CLOSED;
        if (!expired && !closed) revert CampaignNotExpired();

        uint256 remaining = c.totalAllocation - c.claimedAmount;
        require(remaining > 0, "Nothing to refund");
        c.claimedAmount = c.totalAllocation; // prevent re-entry

        address recipient = projects[c.projectId].owner;
        _disburse(c.token, recipient, remaining);
        emit UnclaimedRefunded(campaignId, recipient, remaining);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PLATFORM ADMIN
    // ══════════════════════════════════════════════════════════════════════════

    function setFee(uint256 feeBps) external onlyRole(PLATFORM_ADMIN) {
        if (feeBps > MAX_FEE_BPS) revert InvalidFee();
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(feeBps);
    }

    function setFeeRecipient(address recipient) external onlyRole(PLATFORM_ADMIN) {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function pausePlatform()  external onlyRole(PLATFORM_ADMIN) { _pause(); }
    function resumePlatform() external onlyRole(PLATFORM_ADMIN) { _unpause(); }

    function adminPauseCampaign(uint256 campaignId)
        external
        onlyRole(PLATFORM_ADMIN)
        campaignExists(campaignId)
    {
        campaigns[campaignId].status = CampaignStatus.PAUSED;
        emit CampaignStatusChanged(campaignId, CampaignStatus.PAUSED);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    function getProject(uint256 projectId) external view returns (Project memory) {
        return projects[projectId];
    }

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        return campaigns[campaignId];
    }

    function getProjectCampaigns(uint256 projectId) external view returns (uint256[] memory) {
        return projectCampaigns[projectId];
    }

    function getUserClaimedAmount(uint256 campaignId, address user) external view returns (uint256) {
        return claimedByUser[campaignId][user];
    }

    function totalProjects()  external view returns (uint256) { return _projectIdCounter; }
    function totalCampaigns() external view returns (uint256) { return _campaignIdCounter; }

    /**
     * @notice Preview how much a user can claim right now (vesting-aware).
     */
    function previewClaimable(uint256 campaignId, uint256 fullAmount, address user)
        external
        view
        campaignExists(campaignId)
        returns (uint256)
    {
        Campaign storage c = campaigns[campaignId];
        if (hasClaimed[campaignId][user]) return 0;
        uint256 vested = _calcVested(c, fullAmount);
        uint256 alreadyClaimed = claimedByUser[campaignId][user];
        if (vested <= alreadyClaimed) return 0;
        return vested - alreadyClaimed;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  INTERNALS
    // ══════════════════════════════════════════════════════════════════════════

    function _assertClaimable(Campaign storage c) internal view {
        if (c.status != CampaignStatus.ACTIVE) revert CampaignNotActive();
        if (block.timestamp < c.startTime)     revert CampaignNotActive();
        if (block.timestamp > c.endTime)       revert CampaignNotActive();
    }

    function _calcVested(Campaign storage c, uint256 fullAmount) internal view returns (uint256) {
        if (c.vestingDuration == 0) return fullAmount;
        uint256 elapsed = block.timestamp - c.startTime;
        if (elapsed >= c.vestingDuration) return fullAmount;
        return (fullAmount * elapsed) / c.vestingDuration;
    }

    function _vestingClaimable(Campaign storage c, uint256 fullAmount, uint256 campaignId)
        internal
        view
        returns (uint256)
    {
        uint256 vested = _calcVested(c, fullAmount);
        uint256 already = claimedByUser[campaignId][msg.sender];
        if (vested <= already) return 0;
        return vested - already;
    }

    function _disburse(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    receive() external payable {}
}
