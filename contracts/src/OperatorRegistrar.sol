// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IOperatorRegistry {
    function register(string calldata label, address owner, address subregistry, address resolver, uint256 roleBitmap, uint64 expiry) external returns (uint256);
    function renew(uint256 anyId, uint64 expiry) external;
}

/// @notice Curated, free registration. No stake or deposit. Fixed-size entries are storage-provable.
/// Grant this contract ROLE_REGISTRAR and ROLE_RENEW only; no person needs ROLE_UNREGISTER.
contract OperatorRegistrar {
    struct Operator {
        bytes32 label;       // slot 0 within entry: ASCII label, right-padded, 1..31 bytes
        address operator;   // slot 1: low 160 bits
        uint64 expiry;      // slot 1: next 64 bits, effective listing expiry
        bool active;        // slot 1: next 8 bits
        address payee;      // slot 2: low 160 bits; authenticated payment destination
    }

    // Layout is a public protocol: length at slot 0, entries at keccak256(uint256(0)), stride 3.
    Operator[] public operators;
    mapping(bytes32 => uint256) private indexPlusOne;
    IOperatorRegistry public immutable registry;
    address public immutable curator;
    uint256 public constant MAX_OPERATORS = 128;
    uint64 public constant MAX_LEASE = 30 days;
    uint256 private constant NEW_SLOT = type(uint256).max;

    event Listed(uint256 indexed index, bytes32 indexed label, address operator, address payee, uint64 expiry);
    event Removed(uint256 indexed index);
    event Reinstated(uint256 indexed index);
    event Renewed(uint256 indexed index, uint64 expiry);
    event PayeeChanged(uint256 indexed index, address payee);
    error Unauthorized();
    error InvalidOperator();

    constructor(IOperatorRegistry registry_, address curator_) {
        if (address(registry_).code.length == 0 || curator_ == address(0)) revert InvalidOperator();
        registry = registry_;
        curator = curator_;
    }

    /// @notice List a label. A new label takes the next slot; a label listed before reuses its own slot once its lease has expired.
    function register(string calldata label, address operator, address resolver, address payee, uint64 expiry) external returns (uint256) {
        return _register(NEW_SLOT, label, operator, resolver, payee, expiry);
    }

    /// @notice List a label in the slot of an entry whose lease has expired, replacing that entry.
    /// MAX_OPERATORS then bounds the list, not every label that was ever used.
    function registerInSlot(uint256 slot, string calldata label, address operator, address resolver, address payee, uint64 expiry) external returns (uint256) {
        if (slot >= operators.length) revert InvalidOperator();
        return _register(slot, label, operator, resolver, payee, expiry);
    }

    function _register(uint256 slot, string calldata label, address operator, address resolver, address payee, uint64 expiry) private returns (uint256 index) {
        if (msg.sender != curator) revert Unauthorized();
        if (operator == address(0) || resolver.code.length == 0 || payee == address(0)) revert InvalidOperator();
        _validExpiry(expiry);
        bytes32 packed = _pack(label);
        index = _claim(slot, packed);
        operators[index] = Operator(packed, operator, expiry, true, payee);
        // No transfer, resolver-change or subregistry role is granted to the name owner.
        // Each operator controls only its own resolver's limited text-key role separately.
        registry.register(label, operator, address(0), resolver, 0, expiry);
        emit Listed(index, packed, operator, payee, expiry);
    }

    /// Lowercase ASCII letters, digits and inner hyphens, 1..31 bytes, right-padded with zero bytes.
    function _pack(string calldata label) private pure returns (bytes32) {
        bytes calldata raw = bytes(label);
        if (raw.length == 0 || raw.length > 31) revert InvalidOperator();
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            if (!(c >= 0x61 && c <= 0x7a || c >= 0x30 && c <= 0x39 || c == 0x2d && i != 0 && i + 1 != raw.length)) revert InvalidOperator();
        }
        // ENS name normalization refuses hyphens in both the third and fourth places.
        if (raw.length > 3 && raw[2] == 0x2d && raw[3] == 0x2d) revert InvalidOperator();
        return bytes32(raw);
    }

    /// Pick the slot for a label. Any slot that already holds an entry must have an expired lease.
    function _claim(uint256 slot, bytes32 packed) private returns (uint256 index) {
        uint256 existing = indexPlusOne[packed];
        if (existing == 0 && slot == NEW_SLOT) {
            index = operators.length;
            if (index >= MAX_OPERATORS) revert InvalidOperator();
            operators.push();
            indexPlusOne[packed] = index + 1;
            return index;
        }
        // A label never occupies two slots: one listed before keeps its own.
        index = existing == 0 ? slot : existing - 1;
        if (slot != NEW_SLOT && slot != index) revert InvalidOperator();
        if (operators[index].expiry > block.timestamp) revert InvalidOperator();
        if (existing == 0) {
            delete indexPlusOne[operators[index].label];
            indexPlusOne[packed] = index + 1;
        }
    }

    function renew(uint256 index, uint64 expiry) external {
        Operator storage op = operators[index];
        bool byCurator = msg.sender == curator;
        if (!byCurator && msg.sender != op.operator) revert Unauthorized();
        // An operator extends a running lease. Once it has lapsed, only the curator brings it back.
        if (!op.active || expiry <= op.expiry || (!byCurator && op.expiry <= block.timestamp)) revert InvalidOperator();
        _validExpiry(expiry);
        op.expiry = expiry;
        registry.renew(uint256(keccak256(bytes(_label(op.label)))), expiry);
        emit Renewed(index, expiry);
    }

    /// @notice Delist immediately. The ENS token expires on schedule; no global unregister role.
    /// Naming the operator keeps a late transaction from delisting a slot's next occupant.
    function remove(uint256 index, address operator) external {
        if (msg.sender != curator) revert Unauthorized();
        Operator storage op = operators[index];
        if (!op.active || op.operator != operator) revert InvalidOperator();
        op.active = false;
        emit Removed(index);
    }

    /// @notice Undo a removal. The lease is unchanged; a lapsed one still needs the curator to renew it.
    function reinstate(uint256 index) external {
        if (msg.sender != curator) revert Unauthorized();
        Operator storage op = operators[index];
        if (op.active) revert InvalidOperator();
        op.active = true;
        emit Reinstated(index);
    }

    function setPayee(uint256 index, address payee) external {
        Operator storage op = operators[index];
        if (msg.sender != op.operator) revert Unauthorized();
        if (payee == address(0) || !op.active || op.expiry <= block.timestamp) revert InvalidOperator();
        op.payee = payee;
        emit PayeeChanged(index, payee);
    }

    function operatorCount() external view returns (uint256) { return operators.length; }
    function _validExpiry(uint64 expiry) private view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_LEASE) revert InvalidOperator();
    }
    function _label(bytes32 packed) private pure returns (string memory) {
        uint256 length;
        while (length < 32 && packed[length] != 0) ++length;
        bytes memory raw = new bytes(length);
        for (uint256 i; i < length; ++i) raw[i] = packed[i];
        return string(raw);
    }
}
