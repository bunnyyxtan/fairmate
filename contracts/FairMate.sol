// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * FairMate proof contracts (Wave 3 proof-of-riskiest-legs).
 *
 * Honest trust model, stated exactly: the REFEREE (the FairMate server wallet)
 * is the only writer. What the chain provides in this MVP is a tamper-evident,
 * timestamped, public journal binding each game's board states and moves to
 * TEE inference receipts, plus a prize pot whose payouts are public transfers.
 * The referee being centralized is documented openly; replacing referee trust
 * with on-chain move verification is the stated continuation work.
 */

/// Per-game journal: board-state commitments bound to TEE receipt hashes.
contract MoveJournal {
    struct GameMeta {
        bytes32 startFenHash;
        address player;
        uint64 startedAt;
        uint32 moveCount;
        bool exists;
    }

    address public immutable referee;
    mapping(bytes32 => GameMeta) public games;

    event GameStarted(
        bytes32 indexed gameId,
        bytes32 startFenHash,
        address indexed player,
        string model,
        address teeSigner
    );
    event MoveCommitted(
        bytes32 indexed gameId,
        uint32 indexed moveNo,
        bytes32 fenBeforeHash,
        bytes32 fenAfterHash,
        string san,
        bytes32 receiptHash
    );

    error NotReferee();
    error GameAlreadyExists();
    error NoSuchGame();
    error ZeroHash();

    modifier onlyReferee() {
        if (msg.sender != referee) revert NotReferee();
        _;
    }

    constructor() {
        referee = msg.sender;
    }

    function startGame(
        bytes32 gameId,
        bytes32 startFenHash,
        address player,
        string calldata model,
        address teeSigner
    ) external onlyReferee {
        if (games[gameId].exists) revert GameAlreadyExists();
        if (startFenHash == bytes32(0)) revert ZeroHash();
        games[gameId] = GameMeta({
            startFenHash: startFenHash,
            player: player,
            startedAt: uint64(block.timestamp),
            moveCount: 0,
            exists: true
        });
        emit GameStarted(gameId, startFenHash, player, model, teeSigner);
    }

    /// Commit one AI move: board hash before/after, SAN, and the hash of the
    /// TEE receipt (chatID + provider signature + content hash).
    function commitMove(
        bytes32 gameId,
        bytes32 fenBeforeHash,
        bytes32 fenAfterHash,
        string calldata san,
        bytes32 receiptHash
    ) external onlyReferee returns (uint32 moveNo) {
        GameMeta storage g = games[gameId];
        if (!g.exists) revert NoSuchGame();
        if (fenBeforeHash == bytes32(0) || fenAfterHash == bytes32(0) || receiptHash == bytes32(0)) {
            revert ZeroHash();
        }
        g.moveCount += 1;
        moveNo = g.moveCount;
        emit MoveCommitted(gameId, moveNo, fenBeforeHash, fenAfterHash, san, receiptHash);
    }

    function moveCount(bytes32 gameId) external view returns (uint32) {
        if (!games[gameId].exists) revert NoSuchGame();
        return games[gameId].moveCount;
    }
}

/// Builder-funded challenge pot. Free entry; money only flows OUT to winners.
contract ChallengePot {
    address public immutable owner;
    address public referee;
    uint256 public perWinBounty;
    uint256 public dailyCap;
    uint256 public paidInWindow;
    uint64 public windowStart;
    mapping(bytes32 => bool) public rewarded;

    event Funded(address indexed from, uint256 amount);
    event BountyConfigured(uint256 perWinBounty, uint256 dailyCap);
    event RefereeChanged(address indexed referee);
    event WinAwarded(bytes32 indexed gameId, address indexed winner, uint256 amount);
    event Defunded(address indexed to, uint256 amount);

    error NotOwner();
    error NotReferee();
    error AlreadyRewarded();
    error BountyNotConfigured();
    error DailyCapExceeded();
    error InsufficientPot();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlyReferee() {
        if (msg.sender != referee) revert NotReferee();
        _;
    }

    constructor(address referee_) {
        if (referee_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        referee = referee_;
        windowStart = uint64(block.timestamp);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function configureBounty(uint256 perWinBounty_, uint256 dailyCap_) external onlyOwner {
        perWinBounty = perWinBounty_;
        dailyCap = dailyCap_;
        emit BountyConfigured(perWinBounty_, dailyCap_);
    }

    function setReferee(address referee_) external onlyOwner {
        if (referee_ == address(0)) revert ZeroAddress();
        referee = referee_;
        emit RefereeChanged(referee_);
    }

    /// Award the per-win bounty for a finished, referee-verified game.
    function awardWin(bytes32 gameId, address payable winner) external onlyReferee {
        if (winner == address(0)) revert ZeroAddress();
        if (rewarded[gameId]) revert AlreadyRewarded();
        if (perWinBounty == 0) revert BountyNotConfigured();

        // roll the 24h window
        if (block.timestamp >= uint256(windowStart) + 1 days) {
            windowStart = uint64(block.timestamp);
            paidInWindow = 0;
        }
        if (paidInWindow + perWinBounty > dailyCap) revert DailyCapExceeded();
        if (address(this).balance < perWinBounty) revert InsufficientPot();

        rewarded[gameId] = true;
        paidInWindow += perWinBounty;
        (bool ok, ) = winner.call{ value: perWinBounty }("");
        if (!ok) revert TransferFailed();
        emit WinAwarded(gameId, winner, perWinBounty);
    }

    /// Owner can reclaim remaining pot (shutting the challenge down is public).
    function defund(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(this).balance < amount) revert InsufficientPot();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit Defunded(to, amount);
    }

    function potBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
